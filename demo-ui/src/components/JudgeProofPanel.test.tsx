import { fireEvent, render, screen, within } from "@testing-library/react";
import { JudgeProofPanel } from "./JudgeProofPanel";
import { TopBar } from "./TopBar";

describe("JudgeProofPanel", () => {
  it("renders the shared audit explainer, judge-first replay copy, and example prompt chips", () => {
    const onReplayRecommended = vi.fn();

    render(
      <JudgeProofPanel
        recommendedDemoCard={{
          title: "Recommended audit demo",
          subtitle: "Primary NYC audit path",
          queryText: "safety incident reports in New York with supporting narrative",
          filters: {
            cityCode: "nyc-tlc",
            docType: "Safety_Incident_Log",
          },
          scopeLine: "City NYC-TLC ; Document type Safety_Incident_Log",
        }}
        onReplayRecommended={onReplayRecommended}
      />,
    );

    expect(
      screen.getByRole("heading", {
        name: /optional supporting notes for the audit-response story and cold-archive retrieval claim/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /run the main judge path first\. these notes are supporting evidence after the demo, not the primary evaluation path/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /open them if you want retrieval proof, runtime context, or optional scope-assist background/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /what this demo is auditing/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /start with the same audit story as the hero: a vague archive request comes in, trace keeps the requested slice visible, and the run ends with narrowed evidence plus a reviewer-ready briefing/i,
      ),
    ).toBeInTheDocument();

    expect(screen.getByText(/vague audit request received/i)).toBeInTheDocument();
    expect(screen.getByText(/audit slice kept visible/i)).toBeInTheDocument();
    expect(screen.getByText(/reviewer-ready briefing out/i)).toBeInTheDocument();

    const replayButton = screen.getByRole("button", {
      name: /replay the recommended audit path/i,
    });
    expect(replayButton).toBeInTheDocument();
    fireEvent.click(replayButton);
    expect(onReplayRecommended).toHaveBeenCalledTimes(1);

    const promptChips = screen.getByLabelText(/example prompt chips/i);
    expect(
      within(promptChips).getByText(
        /safety incident reports in new york with supporting narrative/i,
      ),
    ).toBeInTheDocument();
    expect(
      within(promptChips).getByText(
        /recent vehicle inspection audit with overdue paperwork/i,
      ),
    ).toBeInTheDocument();
  });

  it("renders friendly filter labels while preserving the recommended audit context", () => {
    render(
      <JudgeProofPanel
        recommendedDemoCard={{
          title: "Recommended audit demo",
          subtitle: "Primary NYC audit path",
          queryText: "Chicago insurance lapse cases in March 2026",
          filters: {
            cityCode: "chi-bacp",
            docType: "Insurance_Lapse_Report",
            startDate: "2026-03-01",
            endDate: "2026-03-31",
          },
          scopeLine:
            "City CHI-BACP ; Document type Insurance_Lapse_Report ; From 2026-03-01 ; Through 2026-03-31",
        }}
        onReplayRecommended={() => {}}
      />,
    );

    expect(
      screen.getAllByText(
        /audit slice: city chi-bacp \| document insurance lapse report \| from 2026-03-01 \| through 2026-03-31/i,
      ).length,
    ).toBeGreaterThan(0);

    fireEvent.click(screen.getByText(/architecture and runtime snapshot/i));

    expect(
      screen.getByText(
        /replay the currently recommended audit path to inspect the live curated scenario that the app is guiding judges through first/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /use the replay path above to verify that the visible query, active audit slice, and resulting evidence stay aligned from search to handoff/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /these artifacts are supporting evidence, not the main demo/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/broader retrieval without a declared audit slice/i),
    ).toBeInTheDocument();
  });

  it("keeps bundled proof copy aligned when the live recommended case matches a preset", () => {
    render(
      <JudgeProofPanel
        recommendedDemoCard={{
          title: "Recommended first audit path",
          subtitle: "NYC safety archive slice carried through to handoff",
          queryText: "safety incident reports in New York with supporting narrative",
          filters: {
            cityCode: "nyc-tlc",
            docType: "safety_incident_log",
          },
          scopeLine: "City NYC-TLC ; Document type Safety_Incident_Log",
        }}
        onReplayRecommended={() => {}}
      />,
    );

    fireEvent.click(screen.getByText(/architecture and runtime snapshot/i));

    expect(
      screen.getByText(
        /show the primary audit story end to end: vague request in, nyc safety slice held visible, narrowed evidence out, reviewer-ready briefing delivered/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /look for nyc-tlc and the safety incident log slice staying visible through the result stack, provenance block, and final handoff copy/i,
      ),
    ).toBeInTheDocument();
  });
});

describe("TopBar", () => {
  it("uses the specific recommended scenario as the primary CTA accessible name", () => {
    render(
      <TopBar
        health={{
          ready: true,
          label: "Ready",
          capabilities: { scopeInterpretation: false },
        }}
        onRunRecommended={() => {}}
        onTryOwnQuery={() => {}}
        recommendedScenarioLabel="NYC safety audit response"
      />,
    );

    expect(
      screen.getByRole("button", {
        name: /run recommended nyc safety audit response/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: /^run recommended audit demo$/i,
      }),
    ).not.toBeInTheDocument();
  });
});
