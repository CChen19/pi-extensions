import assert from "node:assert/strict";
import { test, vi } from "vitest";

const markdown = vi.hoisted(() => ({
  createMermaidMarkdownTransformer: vi.fn(),
  prepareMermaidMarkdownRenderer: vi.fn(),
}));

vi.mock("@narumitw/pi-tui-kit/markdown", () => markdown);

import { prepareBtwTranscriptMarkdown } from "../src/transcript-markdown.js";

test("Mermaid preparation stops waiting on cancellation and handles late failure", async () => {
  let rejectPreparation: ((error: Error) => void) | undefined;
  markdown.prepareMermaidMarkdownRenderer.mockReturnValueOnce(
    new Promise<void>((_resolve, reject) => {
      rejectPreparation = reject;
    }),
  );
  const controller = new AbortController();
  const preparation = prepareBtwTranscriptMarkdown([], "```mermaid\nflowchart LR\n A --> B\n```", controller.signal);
  await vi.waitFor(() => assert.equal(markdown.prepareMermaidMarkdownRenderer.mock.calls.length, 1));

  controller.abort();

  assert.equal(await preparation, undefined);
  assert.ok(rejectPreparation);
  rejectPreparation(new Error("late renderer failure"));
  await new Promise<void>((resolve) => setImmediate(resolve));
});
