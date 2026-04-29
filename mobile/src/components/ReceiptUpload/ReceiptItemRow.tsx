import { memo, useCallback } from "react";
import { Pressable, Switch, Text, TextInput, View } from "react-native";
import { styles } from "./ReceiptUpload.styles";

export type ReceiptRowField = "name" | "quantity" | "included";

export type ReceiptItemRowProps = {
  id: string;
  name: string;
  quantity: number;
  price: number | null;
  included: boolean;
  onUpdate: (
    id: string,
    field: ReceiptRowField,
    value: string | number | boolean,
  ) => void;
  onRemove: (id: string) => void;
};

function ReceiptItemRowComponent({
  id,
  name,
  quantity,
  price,
  included,
  onUpdate,
  onRemove,
}: ReceiptItemRowProps) {
  const handleIncluded = useCallback(
    (next: boolean) => onUpdate(id, "included", next),
    [id, onUpdate],
  );
  const handleName = useCallback(
    (text: string) => onUpdate(id, "name", text),
    [id, onUpdate],
  );
  const handleQty = useCallback(
    (text: string) => {
      const parsed = parseInt(text, 10);
      const safe = Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
      onUpdate(id, "quantity", safe);
    },
    [id, onUpdate],
  );
  const handleRemove = useCallback(() => onRemove(id), [id, onRemove]);

  return (
    <View style={styles.rowCard}>
      <View style={styles.rowTopRow}>
        <Switch value={included} onValueChange={handleIncluded} />
        <Text style={styles.rowLabel}>
          {price != null ? `$${price.toFixed(2)}` : "—"}
        </Text>
        <Pressable
          onPress={handleRemove}
          hitSlop={8}
          accessibilityLabel="Remove row"
        >
          <Text style={styles.rowPrice}>✕</Text>
        </Pressable>
      </View>

      <View style={styles.rowFieldRow}>
        <Text style={styles.rowLabel}>Name</Text>
        <TextInput
          defaultValue={name}
          onChangeText={handleName}
          style={styles.rowInput}
          placeholder="Item name"
          autoCorrect={false}
        />
      </View>

      <View style={styles.rowFieldRow}>
        <Text style={styles.rowLabel}>Qty</Text>
        <TextInput
          defaultValue={String(quantity)}
          onChangeText={handleQty}
          style={[styles.rowInput, styles.qtyInput]}
          keyboardType="number-pad"
          inputMode="numeric"
        />
      </View>
    </View>
  );
}

export const ReceiptItemRow = memo(ReceiptItemRowComponent);
