import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { render, screen } from "@testing-library/react";
import App from "./App";

const stylesPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "styles.css",
);

function readStylesheet(): string {
  return readFileSync(stylesPath, "utf8");
}

function expectDocumentOrder(first: HTMLElement, second: HTMLElement) {
  expect(
    first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).not.toBe(0);
}

describe("styles", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("includes a reduced-motion fallback for the redesigned investigation surface", () => {
    const css = readStylesheet();

    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain(".desk-card");
    expect(css).toContain("animation: none;");
    expect(css).toContain(".query-input");
    expect(css).toContain(".text-input");
    expect(css).toContain(".case-card");
    expect(css).toContain("transition: none;");
    expect(css).toContain(".case-card:hover");
    expect(css).toContain("transform: none;");
  });

  it("keeps the rendered workspace in the intended narrative order for mobile stacking", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);

        if (url.endsWith("/api/cases")) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => [],
          } as Response;
        }

        if (url.endsWith("/api/health")) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ ok: true }),
          } as Response;
        }

        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(<App />);

    const composerHeading = screen.getByText(
      /frame the request and lock the scope you can defend/i,
    );
    const curatedCasesHeading = await screen.findByText(/start from a known pressure case/i);
    const reasoningHeading = screen.getByText(/interpreted request and active scope/i);

    expectDocumentOrder(composerHeading, curatedCasesHeading);
    expectDocumentOrder(curatedCasesHeading, reasoningHeading);
  });
});
