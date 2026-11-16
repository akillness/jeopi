import type { Database } from "bun:sqlite";
import { dirname, join, normalize } from "node:path";

export type Conf = "local" | "import" | "name";
const MAX_AMBIGUOUS = 5;
const EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

interface Imp { file_id: number; spec: string; imported: string; local: string; reexport: number }
interface Ref { src_id: number; name: string; kind: string; recv: string; file_id: number }
interface Def { id: number; file_id: number; name: string; kind: string }

export function rebuildEdges(db: Database): void {
  const files = db.query("SELECT id, path FROM code_files").all() as { id: number; path: string }[];
  const pathToId = new Map(files.map((f) => [f.path, f.id]));
  const idToPath = new Map(files.map((f) => [f.id, f.path]));
  const defs = db.query("SELECT id, file_id, name, kind FROM code_nodes").all() as Def[];
  const defsByName = new Map<string, Def[]>();
  const defsByFileName = new Map<string, Def[]>();
  const moduleOf = new Map<number, number>();
  for (const d of defs) {
    if (d.kind === "module") { moduleOf.set(d.file_id, d.id); continue; }
    (defsByName.get(d.name) ?? defsByName.set(d.name, []).get(d.name)!).push(d);
    const k = `${d.file_id}|${d.name}`;
    (defsByFileName.get(k) ?? defsByFileName.set(k, []).get(k)!).push(d);
  }

  const resolveSpec = (fromFileId: number, spec: string): number | null => {
    if (!spec.startsWith(".")) return null;
    const base = normalize(join(dirname(idToPath.get(fromFileId)!), spec));
    const stripped = base.replace(/\.(m|c)?jsx?$/, "");
    const tries = [base, ...EXTS.map((e) => stripped + e), ...EXTS.map((e) => join(base, "index" + e))];
    for (const t of tries) { const id = pathToId.get(t); if (id !== undefined) return id; }
    return null;
  };

  const imps = db.query("SELECT file_id, spec, imported, local, reexport FROM code_imports").all() as Imp[];
  const byLocal = new Map<number, Map<string, Imp>>();
  const reexports = new Map<number, Imp[]>();
  const resolved = new Map<Imp, number | null>();
  for (const i of imps) {
    resolved.set(i, resolveSpec(i.file_id, i.spec));
    if (i.reexport) (reexports.get(i.file_id) ?? reexports.set(i.file_id, []).get(i.file_id)!).push(i);
    else (byLocal.get(i.file_id) ?? byLocal.set(i.file_id, new Map()).get(i.file_id)!).set(i.local, i);
  }

  const resolveDef = (fileId: number, name: string, depth = 0): Def[] => {
    const direct = defsByFileName.get(`${fileId}|${name}`);
    if (direct?.length) return direct;
    if (depth >= 4) return [];
    for (const r of reexports.get(fileId) ?? []) {
      const target = resolved.get(r);
      if (target == null) continue;
      if (r.imported === "*") { const d = resolveDef(target, name, depth + 1); if (d.length) return d; }
      else if (r.local === name) { const d = resolveDef(target, r.imported, depth + 1); if (d.length) return d; }
    }
    return [];
  };

  const seen = new Set<string>();
  const rows: [number, number, string, Conf][] = [];
  const add = (src: number, ds: Def[], kind: string, conf: Conf) => {
    for (const d of ds) {
      if (d.id === src) continue;
      const k = `${src}|${d.id}|${kind}`;
      if (seen.has(k)) continue;
      seen.add(k); rows.push([src, d.id, kind, conf]);
    }
  };

  for (const i of imps) {
    if (i.reexport || i.imported === "*") continue;
    const target = resolved.get(i);
    const mod = moduleOf.get(i.file_id);
    if (target == null || mod === undefined) continue;
    add(mod, resolveDef(target, i.imported === "default" ? i.local : i.imported), "imports", "import");
  }

  const refs = db.query(`SELECT r.src_id, r.name, r.kind, r.recv, n.file_id FROM code_refs r JOIN code_nodes n ON n.id = r.src_id`).all() as Ref[];
  for (const r of refs) {
    const ctx = byLocal.get(r.file_id);
    const sameFile = defsByFileName.get(`${r.file_id}|${r.name}`) ?? [];
    if (r.recv === "this") {
      if (sameFile.length) { add(r.src_id, sameFile, r.kind, "local"); continue; }
    } else if (r.recv && r.recv !== "#") {
      const ns = ctx?.get(r.recv);
      if (ns && ns.imported === "*") {
        const t = resolved.get(ns);
        if (t != null) add(r.src_id, resolveDef(t, r.name), r.kind, "import");
        continue;
      }
    } else if (!r.recv) {
      const imp = ctx?.get(r.name);
      if (imp) {
        const t = resolved.get(imp);
        if (t != null) add(r.src_id, resolveDef(t, imp.imported === "default" || imp.imported === "*" ? imp.local : imp.imported), r.kind, "import");
        continue;
      }
      if (sameFile.length) { add(r.src_id, sameFile, r.kind, "local"); continue; }
    }
    const cands = defsByName.get(r.name) ?? [];
    if (cands.length > 0 && cands.length <= MAX_AMBIGUOUS) add(r.src_id, cands, r.kind, "name");
  }

  db.exec("DELETE FROM code_edges");
  const ins = db.prepare("INSERT INTO code_edges(src_id,dst_id,kind,conf) VALUES (?,?,?,?)");
  for (const r of rows) ins.run(...r);
}
