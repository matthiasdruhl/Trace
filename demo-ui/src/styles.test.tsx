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
    expect(css).toContain(".off-script-banner");
    expect(css).toContain(".off-script-banner-actions");
    expect(css).toContain(".judge-instructions-card");
  });

  it("ships class hooks and narrow-width layouts for the judge instructions and off-script banner", () => {
    const css = readStylesheet();

    expect(css).toContain(".judge-instructions-card");
    expect(css).toContain(".judge-instructions-list");
    expect(css).toContain(".judge-instructions-item");
    expect(css).toContain(".judge-instructions-footer");
    expect(css).toContain(".off-script-banner");
    expect(css).toContain(".off-script-banner-actions");
    expect(css).toContain(".off-script-banner-note");
    expect(css).toContain(".judge-instructions-card,");
    expect(css).toContain(".off-script-banner-actions,");
  });

  it("keeps the live workspace ahead of the proof panel in the rendered order", async () => {
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

    const heroHeading = await screen.findByRole("heading", {
      name: /turn a vague compliance audit request into narrowed evidence and a handoff-ready briefing/i,
    });
    const valueHeading = screen.getByRole("heading", {
      name: /manual audit review is slow and scattered\. trace compresses it into one visible workflow/i,
    });
    const workspaceHeading = screen.getByRole("heading", {
      name: /use the recommended audit path first, then judge the handoff package it produces/i,
    });
    const guidedHeading = screen.getByRole("heading", {
      name: /start with (one )?recommended audit (response|demo)/i,
    });
    const composerHeading = screen.getByText(
      /frame a request, tighten the scope, then run the search/i,
    );
    const reasoningHeading = screen.getByText(/what trace is currently trying to prove/i);
    const proofHeading = screen.getByRole("heading", {
      name: /optional supporting notes for the audit-response story and cold-archive retrieval claim/i,
    });

    expectDocumentOrder(heroHeading, valueHeading);
    expectDocumentOrder(valueHeading, workspaceHeading);
    expectDocumentOrder(workspaceHeading, guidedHeading);
    expectDocumentOrder(guidedHeading, composerHeading);
    expectDocumentOrder(composerHeading, reasoningHeading);
    expectDocumentOrder(reasoningHeading, proofHeading);
  });
});
