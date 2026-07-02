import type { ExtensionFactory } from "jeopi-cli";
import { Container, Text } from "jeopi-tui";

const extension: ExtensionFactory = pi => {
	pi.setLabel("Thinking note");
	pi.registerAssistantThinkingRenderer((context, theme) => {
		const container = new Container();
		container.addChild(new Text(theme.fg("dim", `thinking chars: ${context.text.length}`), 1, 0));
		return container;
	});
};

export default extension;
