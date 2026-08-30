import { fireEvent, render, screen } from "@testing-library/react-native";
import { useState } from "react";

import { ProductLabelInput, uniqueProductLabels } from "../../src/components/ProductLabelInput";

jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));

function ControlledInput({ disabled = false }: { disabled?: boolean }) {
  const [value, setValue] = useState("");
  return <ProductLabelInput
    value={value}
    onChangeText={setValue}
    suggestions={["Milk", " almond milk ", "MILK", "Apple", "Bread", "Orange", "Yogurt"]}
    disabled={disabled}
  />;
}

describe("ProductLabelInput", () => {
  test("normalizes and de-duplicates product labels while preserving display text", () => {
    expect(uniqueProductLabels([" Milk ", "milk", null, "", "APPLE", "apple"])).toEqual(["Milk", "APPLE"]);
  });

  test("ranks prefix matches before contains matches and selects a suggestion", async () => {
    await render(<ControlledInput />);
    const input = screen.getByLabelText("Product label");
    await fireEvent(input, "focus");
    await fireEvent.changeText(input, "mil");
    const suggestions = screen.getAllByRole("button");
    expect(suggestions.map((item) => item.props.accessibilityLabel)).toEqual([
      "Use product label Milk",
      "Use product label almond milk",
    ]);
    await fireEvent(suggestions[1], "pressIn");
    expect(screen.getByLabelText("Product label")).toHaveDisplayValue("almond milk");
    await fireEvent.press(suggestions[1]);
    expect(screen.queryByLabelText("Product label suggestions")).toBeNull();
  });

  test("does not expose suggestions while disabled", async () => {
    await render(<ControlledInput disabled />);
    const input = screen.getByLabelText("Product label");
    await fireEvent(input, "focus");
    expect(screen.queryByLabelText("Product label suggestions")).toBeNull();
    expect(input).toBeDisabled();
  });
});
