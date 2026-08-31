import { fireEvent, render } from "@testing-library/react-native";
import { Text } from "react-native";

import { ContributionsMenu } from "../../src/features/teach-fridge/components/contributions/ContributionsMenu";
import { ContributionCard } from "../../src/features/teach-fridge/components/contributions/ContributionCard";
import { ContributionsTab } from "../../src/features/teach-fridge/components/contributions/ContributionsTab";
import { ReviewQueueScreen } from "../../src/features/teach-fridge/components/contributions/ReviewQueueScreen";

jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("../../src/components/DetectionImageViewer", () => ({ DetectionImageViewer: () => null }));

describe("contribution views", () => {
  test("both authorized sections are collapsed by default and expand independently", async () => {
    const view = await render(<ContributionsMenu
      history={<Text>History content</Text>}
      reviewQueue={<Text>Queue content</Text>}
    />);

    expect(view.getByText("Contribution History")).toBeTruthy();
    expect(view.getByText("Review Queue")).toBeTruthy();
    expect(view.queryByText("History content")).toBeNull();
    expect(view.queryByText("Queue content")).toBeNull();

    await fireEvent.press(view.getByText("Contribution History"));
    expect(view.getByText("History content")).toBeTruthy();
    expect(view.queryByText("Queue content")).toBeNull();

    await fireEvent.press(view.getByText("Review Queue"));
    expect(view.getByText("History content")).toBeTruthy();
    expect(view.getByText("Queue content")).toBeTruthy();

    await fireEvent.press(view.getByText("Contribution History"));
    expect(view.queryByText("History content")).toBeNull();
    expect(view.getByText("Queue content")).toBeTruthy();
  });

  test("does not expose Review Queue when no authorized view is supplied", async () => {
    const view = await render(<ContributionsMenu history={<Text>History content</Text>} />);
    expect(view.getByText("Contribution History")).toBeTruthy();
    expect(view.queryByText("Review Queue")).toBeNull();
  });

  test("history retains filters and does not embed the review queue", async () => {
    const view = await render(<ContributionsTab
      contributions={{
        loading: false, error: "", filter: "All", setFilter: jest.fn(), search: "", setSearch: jest.fn(),
        labelFilter: "", setLabelFilter: jest.fn(), sort: "Newest", setSort: jest.fn(), visibleContributions: [],
        groups: [], allowUserSort: true, hasFilters: false, clearFilters: jest.fn(), loadContributions: jest.fn(),
      }}
      productLabelSuggestions={[]}
      contributionMessage=""
      displayNameForModel={() => "Model"}
      onViewImage={jest.fn()}
      onEditLabel={jest.fn()}
      onEditBox={jest.fn()}
    />);

    expect(view.getByText("Contribution history")).toBeTruthy();
    expect(view.getByPlaceholderText("Search by product label")).toBeTruthy();
    expect(view.queryByText("Review queue")).toBeNull();
  });

  test("review screen preserves the moderation queue", async () => {
    const view = await render(<ReviewQueueScreen moderation={{
      submissions: [], loading: false, error: "", message: "", moderatingSubmissionId: null,
      expandedAnnotationIds: new Set(), loadModeration: jest.fn(), moderateSubmission: jest.fn(),
      toggleAnnotationDetails: jest.fn(),
    }} />);
    expect(view.getByText("Review queue")).toBeTruthy();
    expect(view.getByText("0 PENDING")).toBeTruthy();
  });

  test("trusted card names the active model rather than a newer rejected usage", async () => {
    const view = await render(<ContributionCard
      contribution={{
        key: "trusted-lemon",
        submission: {
          id: 10, scan_id: 3, status: "approved", training_lifecycle_state: "trusted",
          image_width: 100, image_height: 100, created_at: "2026-01-02T03:04:05Z",
        },
        annotation: {
          id: 20, submission_id: 10, action: "ADD", source_detection_id: null,
          final_label: "Lemon", created_at: "2026-01-02T03:04:05Z",
        },
        annotations: [{
          id: 20, submission_id: 10, action: "ADD", source_detection_id: null,
          final_label: "Lemon", created_at: "2026-01-02T03:04:05Z",
          training_usages: [
            { dataset_version: "d2", training_run_id: "r2", model_version: "model-8", model_status: "rejected", used_at: "2026-01-06T00:00:00Z" },
            { dataset_version: "d1", training_run_id: "r1", model_version: "model-7", model_status: "active", used_at: "2026-01-05T00:00:00Z" },
          ],
        }],
      }}
      displayNameForModel={(model) => model.version === "model-7" ? "Model 7" : "Model 8"}
      onViewImage={jest.fn()}
      onEditLabel={jest.fn()}
      onEditBox={jest.fn()}
    />);

    expect(view.getByText("Used in Model 7")).toBeTruthy();
    expect(view.queryByText("Used in Model 8")).toBeNull();
    expect(view.getByText("TRUSTED")).toBeTruthy();
  });
});
