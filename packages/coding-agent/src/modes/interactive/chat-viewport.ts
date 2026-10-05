import {
	type Component,
	Container,
	ScrollView,
	type ScrollViewScrollbar,
	VStack,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { CustomEditor } from "./components/custom-editor.ts";
import { scrollToEndLabel } from "./components/keybinding-hints.ts";
import { theme } from "./theme/theme.ts";

export interface ChatViewportOptions {
	readonly document: Component;
	readonly pendingMessages: Component;
	readonly status: Component;
	readonly editor: Component;
	readonly footer: Component;
	readonly widgetsAbove?: Component;
	readonly widgetsBelow?: Component;
	readonly scrollbar?: ScrollViewScrollbar;
	readonly scrollbarTrackStyle?: (text: string) => string;
	readonly scrollbarThumbStyle?: (text: string) => string;
}

export interface ChatViewport {
	readonly root: Component;
	readonly transcript: ScrollView;
}

/** Shared fullscreen transcript and fixed input-dock layout. */
export function createChatViewport(options: ChatViewportOptions): ChatViewport {
	let expanded = false;
	const toggleLabel = () => (expanded ? "[Collapse input]" : "[Expand input]");
	const transcript = new ScrollView(options.document, {
		follow: "end",
		// Growing the transcript when the dock shrinks must not resume following.
		resumeFollowOnLayout: false,
		onFollowChange: () => {
			expanded = false;
		},
		scrollbackAction: () => ({
			label: theme.bg("selectedBg", theme.fg("text", toggleLabel())),
			onClick: () => {
				expanded = !expanded;
			},
		}),
		primary: true,
		overscroll: "chain",
		scrollbar: options.scrollbar ?? "auto",
		...(options.scrollbarTrackStyle === undefined ? {} : { scrollbarTrackStyle: options.scrollbarTrackStyle }),
		...(options.scrollbarThumbStyle === undefined ? {} : { scrollbarThumbStyle: options.scrollbarThumbStyle }),
	});
	const getCompactEditor = (): CustomEditor | undefined => {
		const slot = options.editor;
		const editor = slot instanceof Container && slot.children.length === 1 ? slot.children[0] : slot;
		return editor instanceof CustomEditor ? editor : undefined;
	};
	const showExtras = () => transcript.isFollowingEnd || expanded;
	const showDock = () => showExtras() || getCompactEditor() !== undefined;
	const editorView = new (class extends Container {
		override render(width: number): string[] {
			const editor = transcript.isFollowingEnd || expanded ? undefined : getCompactEditor();
			if (!editor) return super.render(width);
			const previousLimit = editor.maxVisibleLines;
			editor.maxVisibleLines = 1;
			try {
				// Render the real containers so mouse hit-testing uses the same geometry.
				return super.render(width);
			} finally {
				// Other presentations (including regular mode) retain their normal height.
				editor.maxVisibleLines = previousLimit;
			}
		}
	})();
	editorView.addChild(options.editor);
	const scrollWidgets = (component: Component) =>
		new ScrollView(component, {
			overscroll: "contain",
			scrollbar: options.scrollbar ?? "auto",
			...(options.scrollbarTrackStyle === undefined ? {} : { scrollbarTrackStyle: options.scrollbarTrackStyle }),
			...(options.scrollbarThumbStyle === undefined ? {} : { scrollbarThumbStyle: options.scrollbarThumbStyle }),
		});
	const dock = new VStack([
		{ component: options.pendingMessages, shrink: 1, minSize: 0, visible: showExtras },
		{ component: options.status, shrink: 1, minSize: 0, visible: showExtras },
		...(options.widgetsAbove === undefined
			? []
			: [{ component: scrollWidgets(options.widgetsAbove), shrink: 1, minSize: 0, visible: showExtras }]),
		{ component: editorView, shrink: 1, minSize: 3 },
		...(options.widgetsBelow === undefined
			? []
			: [{ component: scrollWidgets(options.widgetsBelow), shrink: 1, minSize: 0, visible: showExtras }]),
		{ component: options.footer, shrink: 0, minSize: 0, visible: showExtras },
	]);
	const needsStackedControls = ({ width, height }: { width: number; height: number }) => {
		if (height < 2 || transcript.isFollowingEnd) return false;
		const availableWidth = width - (transcript.isScrollbarVisible ? 1 : 0);
		return visibleWidth(toggleLabel()) + 1 + visibleWidth(scrollToEndLabel()) > availableWidth;
	};
	return {
		transcript,
		root: new VStack([
			{
				component: transcript,
				basis: 0,
				grow: 1,
				shrink: 1,
				minSize: 1,
				visible: (viewport) => !needsStackedControls(viewport),
			},
			{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 2, visible: needsStackedControls },
			{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1, visible: showDock },
		]),
	};
}
