import type { AIProgressResponse, AnnotationItem, AnnotationSubmission, AnnotationSubmissionDetail } from "../../src/types/api";
import {
  annotationGroupActionTitle,
  combineAnnotationGroup,
  contributionDetection,
  groupAnnotationsForDisplay,
  hasDrawableBox,
} from "../../src/features/teach-fridge/annotationUtils";
import {
  buildSubmissionCorrectionObjects,
  submissionCorrectionSummary,
} from "../../src/features/teach-fridge/submissionCorrections";
import {
  contributionChange,
  contributionStatus,
  filterAndSortContributions,
  groupContributions,
  trainingState,
  trainingStateCopy,
} from "../../src/features/teach-fridge/contributionUtils";
import {
  candidateStateCopy,
  candidateLifecycleControls,
  formatMetric,
  formatMetricDifference,
  groupSubmissionsByLabel,
  metricsForProduct,
  promotionReasonText,
  readableModelName,
} from "../../src/features/teach-fridge/modelUtils";
import type { Contribution } from "../../src/features/teach-fridge/types";

const createdAt = "2026-01-02T03:04:05Z";

function annotation(id: number, action: AnnotationItem["action"], values: Partial<AnnotationItem> = {}): AnnotationItem {
  return {
    id, submission_id: 10, action, created_at: createdAt,
    source_detection_id: 5,
    original_label: "Apple", original_confidence: 0.9,
    original_x1: 10, original_y1: 20, original_x2: 50, original_y2: 70,
    final_label: "Apple", final_x1: 10, final_y1: 20, final_x2: 50, final_y2: 70,
    ...values,
  };
}

function submission(id = 10, values: Partial<AnnotationSubmission> = {}): AnnotationSubmission {
  return {
    id, scan_id: 3, status: "pending", image_width: 100, image_height: 100,
    created_at: createdAt, ...values,
  };
}

function detail(annotations: AnnotationItem[], values: Partial<AnnotationSubmission> = {}): AnnotationSubmissionDetail {
  return { submission: submission(annotations[0]?.submission_id || 10, values), annotations };
}

function contribution(key: string, annotations: AnnotationItem[], values: Partial<AnnotationSubmission> = {}): Contribution {
  return {
    key,
    submission: submission(annotations[0].submission_id, values),
    annotation: combineAnnotationGroup(annotations),
    annotations,
  };
}

describe("Teach Fridge correction reconstruction", () => {
  test("groups source-related RELABEL and ADJUST_BOX rows into one effective correction", () => {
    const relabel = annotation(1, "RELABEL", { final_label: "Pear" });
    const box = annotation(2, "ADJUST_BOX", {
      final_label: "Apple", final_x1: 15, final_y1: 25, final_x2: 60, final_y2: 80,
    });
    const groups = groupAnnotationsForDisplay([relabel, box]);
    expect(groups).toHaveLength(1);
    expect(annotationGroupActionTitle(groups[0])).toBe("Label + area correction");
    expect(combineAnnotationGroup(groups[0])).toMatchObject({
      final_label: "Pear", final_x1: 15, final_y1: 25, final_x2: 60, final_y2: 80,
    });
    const objects = buildSubmissionCorrectionObjects(detail([relabel, box]));
    expect(objects).toHaveLength(1);
    expect(objects[0]).toMatchObject({
      kind: "RELABEL_AND_BOX", finalLabel: "Pear",
      finalBox: { x1: 15, y1: 25, x2: 60, y2: 80 }, annotationIds: [1, 2],
    });
  });

  test.each([
    ["ADD", { source_detection_id: null, original_label: null, final_label: "Lemon" }, "ADD", "Lemon", true],
    ["CONFIRM", {}, "CONFIRM", "Apple", true],
    ["RELABEL", { final_label: "Pear" }, "RELABEL", "Pear", true],
    ["ADJUST_BOX", { final_x1: 12 }, "ADJUST_BOX", "Apple", true],
    ["REMOVE", { final_label: null }, "REMOVE", "Apple", false],
  ] as const)("reconstructs %s actions", (action, values, kind, label, drawable) => {
    const object = buildSubmissionCorrectionObjects(detail([
      annotation(1, action as AnnotationItem["action"], values),
    ]))[0];
    expect(object.kind).toBe(kind);
    expect(object.displayLabel).toBe(label);
    expect(Boolean(object.detection)).toBe(drawable);
  });

  test("keeps separate ADD annotations and tolerates incomplete invalid boxes", () => {
    const first = annotation(1, "ADD", { source_detection_id: null, final_label: "Milk" });
    const second = annotation(2, "ADD", {
      source_detection_id: null, original_label: null, final_label: "Bread",
      original_x1: null, original_y1: null, original_x2: null, original_y2: null,
      final_x1: null, final_y1: null, final_x2: null, final_y2: null,
    });
    const objects = buildSubmissionCorrectionObjects(detail([first, second]));
    expect(objects).toHaveLength(2);
    expect(objects[1].finalBox).toBeNull();
    expect(objects[1].detection).toBeNull();
    expect(submissionCorrectionSummary(detail([first, second]))).toMatchObject({
      labels: ["Milk", "Bread"], objectCount: 2, changeCount: 2,
    });
  });

  test("produces drawable detection data only for valid in-image geometry", () => {
    const corrected = contribution("one", [annotation(1, "RELABEL", { final_label: "Pear" })]);
    expect(contributionDetection(corrected)).toMatchObject({ label: "Pear", x1: 10, y2: 70 });
    expect(hasDrawableBox(contributionDetection(corrected), 100, 100)).toBe(true);
    expect(hasDrawableBox({ ...contributionDetection(corrected), x1: 200, x2: 220 }, 100, 100)).toBe(false);
  });
});

describe("contribution status, filtering, and grouping", () => {
  const apple = contribution("apple", [annotation(1, "CONFIRM")], {
    id: 10, status: "approved", created_at: "2026-01-03T00:00:00Z",
    ...({ submitter_display_name: "Zoe" } as Partial<AnnotationSubmission>),
  });
  const pear = contribution("pear", [annotation(2, "RELABEL", { submission_id: 11, final_label: "Pear" })], {
    id: 11, status: "pending", created_at: "2026-01-02T00:00:00Z",
    ...({ submitter_display_name: "Adam" } as Partial<AnnotationSubmission>),
  });
  const used = contribution("used", [annotation(3, "ADD", {
    submission_id: 12, source_detection_id: null, final_label: "Milk",
    training_usages: [{ dataset_version: "d1", training_run_id: "r1", model_version: "m1", model_status: "active", used_at: "2026-01-04T00:00:00Z" }],
  })], { id: 12, status: "approved" });

  test("interprets moderation and lifecycle states", () => {
    expect(contributionStatus("approved", false)).toBe("READY TO TRAIN");
    expect(contributionStatus("approved", true)).toBe("USED IN TRAINING");
    expect(trainingState(submission(1, { training_lifecycle_state: "quarantined" }))).toBe("quarantined");
    expect(trainingStateCopy("experimental")).toMatchObject({ label: "EXPERIMENTAL", tone: "warning" });
    expect(contributionChange(pear)).toContain("Changed to Pear");
  });

  test("hides used training history from All and exposes it through Used", () => {
    expect(filterAndSortContributions([apple, pear, used], "All", "", "", "Newest").map((item) => item.key)).toEqual(["apple", "pear"]);
    expect(filterAndSortContributions([apple, pear, used], "Used", "", "", "Newest").map((item) => item.key)).toEqual(["used"]);
    expect(filterAndSortContributions([apple, pear], "All", "pea", "", "Newest")).toEqual([pear]);
  });

  test("sorts and groups by effective product or submitter", () => {
    expect(filterAndSortContributions([apple, pear], "All", "", "", "Product").map((item) => item.key)).toEqual(["apple", "pear"]);
    expect(groupContributions([apple, pear], "User").map((group) => group.label)).toEqual(["Zoe", "Adam"]);
  });
});

describe("model display and policy interpretation helpers", () => {
  test.each([
    ["eligible", "ELIGIBLE FOR PROMOTION"],
    ["comparison_stale", "COMPARISON STALE"],
    ["not_eligible", "NOT ELIGIBLE FOR PROMOTION"],
    ["none", "NO CANDIDATE"],
  ] as const)("maps %s candidate state", (state, label) => {
    expect(candidateStateCopy(state).label).toBe(label);
  });

  test("formats metrics, model names, and policy reasons", () => {
    expect(formatMetric(0.615)).toBe("61.5%");
    expect(formatMetricDifference(-0.025)).toBe("-2.5 pp");
    expect(readableModelName({ version: "friendly" }, { friendly: "Candidate 2" })).toBe("Candidate 2");
    expect(readableModelName({ version: "fridge9000-production-initial" }, {})).toBe("Initial Model");
    expect(promotionReasonText({
      code: "shared_class_regression", message: "fallback", difference: -0.03, maximum_regression: 0.02,
    })).toContain("-3.0 pp");
  });

  test("finds class metrics case-insensitively and groups corrected submissions once per label", () => {
    const metrics = { available: true, classes: ["Lemon"], unavailable_classes: [], per_class: {
      Lemon: { precision: 0.8, recall: 0.7, map50: 0.75, map50_95: 0.6 },
    } };
    expect(metricsForProduct(metrics, "lemon")?.map50_95).toBe(0.6);
    const combined = detail([
      annotation(1, "RELABEL", { final_label: "Pear" }),
      annotation(2, "ADJUST_BOX"),
    ]);
    expect(groupSubmissionsByLabel([combined])).toEqual([{ label: "Pear", submissions: [combined] }]);
  });

  test.each([
    ["eligible candidate", "eligible", true, { can_train: false, can_compare: false, can_promote: true, can_reject: true, can_rollback: false }, { showPromote: true, showReject: true, showTrain: false, showRollback: false }],
    ["invalid comparison", "comparison_invalid", true, { can_train: false, can_compare: true, can_promote: false, can_reject: true, can_rollback: false }, { showCompare: true, showPromote: false, showReject: true, showRollback: false }],
    ["auto-rejected candidate", "not_eligible", false, { can_train: true, can_compare: false, can_promote: false, can_reject: false, can_rollback: true }, { showComparisonDetails: true, showPromote: false, showReject: false, showTrain: true, showRollback: true }],
    ["no candidate", "none", false, { can_train: true, can_compare: false, can_promote: false, can_reject: false, can_rollback: true }, { showComparisonDetails: false, showPromote: false, showReject: false, showTrain: true, showRollback: true }],
  ] as const)("renders backend-authoritative controls for %s", (_name, state, unresolved, actions, expected) => {
    const model = { id: 2, version: "candidate-v2", status: unresolved ? "candidate" : "rejected", created_at: createdAt };
    const progress = {
      candidate: unresolved ? model : null,
      latest_candidate: state === "none" ? null : model,
      candidate_state: state,
      comparison: state === "none" ? null : {},
      actions,
    } as unknown as AIProgressResponse;
    expect(candidateLifecycleControls(progress)).toMatchObject(expected);
  });
});
