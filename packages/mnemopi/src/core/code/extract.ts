import ts from "typescript";

export interface RawRef { name: string; kind: "calls" | "extends"; recv: string }
export interface RawImport { spec: string; imported: string; local: string; reexport: boolean }
export interface RawNode {
  name: string; kind: string; startLine: number; endLine: number; exported: boolean; refs: RawRef[];
}
export interface Extracted { nodes: RawNode[]; imports: RawImport[] }

const SCRIPT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
export const isScript = (p: string) => SCRIPT_EXT.test(p);

function scriptKind(p: string): ts.ScriptKind {
  if (p.endsWith("x")) return p.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.JSX;
  return p.endsWith("js") || p.endsWith("mjs") || p.endsWith("cjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

function recvOf(e: ts.Expression): string {
  if (!ts.isPropertyAccessExpression(e)) return "";
  if (e.expression.kind === ts.SyntaxKind.ThisKeyword) return "this";
  return ts.isIdentifier(e.expression) ? e.expression.text : "#";
}

function calleeName(e: ts.Expression): string | undefined {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
}

export function extractScript(path: string, text: string): Extracted {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.ESNext, false, scriptKind(path));
  const line = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const mod: RawNode = { name: "<module>", kind: "module", startLine: 1, endLine: line(sf.end), exported: false, refs: [] };
  const nodes: RawNode[] = [mod];
  const imports: RawImport[] = [];
  const stack: RawNode[] = [mod];
  const cur = () => stack[stack.length - 1]!;
  let anon = 0;

  const isExported = (n: ts.Node) =>
    !!(ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));

  const declare = (name: string, kind: string, n: ts.Node, exported: boolean) => {
    const node: RawNode = { name, kind, startLine: line(n.getStart(sf)), endLine: line(n.end), exported, refs: [] };
    nodes.push(node);
    return node;
  };

  const visit = (n: ts.Node): void => {
    let pushed: RawNode | undefined;
    if (ts.isFunctionDeclaration(n) && n.name) pushed = declare(n.name.text, "function", n, isExported(n));
    else if (ts.isClassDeclaration(n) && n.name) {
      pushed = declare(n.name.text, "class", n, isExported(n));
      for (const h of n.heritageClauses ?? [])
        for (const t of h.types) {
          const nm = calleeName(t.expression);
          if (nm) pushed.refs.push({ name: nm, kind: "extends", recv: recvOf(t.expression) });
        }
    } else if ((ts.isMethodDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n)) && ts.isIdentifier(n.name))
      pushed = declare(n.name.text, "method", n, false);
    else if (ts.isInterfaceDeclaration(n)) pushed = declare(n.name.text, "interface", n, isExported(n));
    else if (ts.isTypeAliasDeclaration(n)) pushed = declare(n.name.text, "type", n, isExported(n));
    else if (ts.isEnumDeclaration(n)) pushed = declare(n.name.text, "enum", n, isExported(n));
    else if (ts.isVariableStatement(n) && (anon > 0 || (cur().kind !== "module" && cur().kind !== "class"))) {
      for (const d of n.declarationList.declarations) if (d.initializer) visit(d.initializer);
      return;
    } else if (ts.isVariableStatement(n)) {
      const exp = isExported(n);
      for (const d of n.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        const fnLike = d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer));
        const node = declare(d.name.text, fnLike ? "function" : "variable", d, exp);
        stack.push(node);
        if (d.initializer) visit(d.initializer);
        stack.pop();
      }
      return;
    } else if (ts.isImportDeclaration(n) && n.importClause) {
      const c = n.importClause;
      const spec = ts.isStringLiteral(n.moduleSpecifier) ? n.moduleSpecifier.text : "";
      if (c.name) imports.push({ spec, imported: "default", local: c.name.text, reexport: false });
      const nb = c.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) imports.push({ spec, imported: "*", local: nb.name.text, reexport: false });
      if (nb && ts.isNamedImports(nb))
        for (const el of nb.elements) imports.push({ spec, imported: (el.propertyName ?? el.name).text, local: el.name.text, reexport: false });
      return;
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      const spec = n.moduleSpecifier.text;
      const ec = n.exportClause;
      if (!ec) imports.push({ spec, imported: "*", local: "*", reexport: true });
      else if (ts.isNamedExports(ec))
        for (const el of ec.elements) imports.push({ spec, imported: (el.propertyName ?? el.name).text, local: el.name.text, reexport: true });
      return;
    } else if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const nm = calleeName(n.expression);
      if (nm) cur().refs.push({ name: nm, kind: "calls", recv: recvOf(n.expression) });
    }
    const isAnon = !pushed && (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && !(n.parent && ts.isVariableDeclaration(n.parent));
    if (pushed) stack.push(pushed);
    if (isAnon) anon++;
    ts.forEachChild(n, visit);
    if (isAnon) anon--;
    if (pushed) stack.pop();
  };
  visit(sf);
  for (const n of nodes) {
    const seen = new Set<string>();
    n.refs = n.refs.filter((r) => (seen.has(`${r.kind}|${r.recv}|${r.name}`) ? false : (seen.add(`${r.kind}|${r.recv}|${r.name}`), true)));
  }
  return { nodes, imports };
}
