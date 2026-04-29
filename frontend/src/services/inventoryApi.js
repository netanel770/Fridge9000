const DEFAULT_API = "http://localhost:8000";

export function getApiBase() {
  return DEFAULT_API;
}

/**
 * Add quantity of an item to the inventory.
 * Backend creates the item if it doesn't exist.
 * @returns {Promise<{ok: boolean, item_id?: number, new_quantity?: number, error?: string}>}
 */
export async function addInventoryItem(itemName, quantity) {
  const res = await fetch(`${getApiBase()}/inventory/manual`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      item_name: itemName,
      action: "Added",
      quantity,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `Request failed: ${res.status}`);
  }
  return data;
}
