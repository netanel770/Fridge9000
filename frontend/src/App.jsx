import { useEffect, useState } from "react";

const API = "http://localhost:8000";

function Card({ title, children }) {
  return (
    <div style={{
      border: "1px solid #ddd",
      borderRadius: 12,
      padding: 16,
      backgroundColor: "var(--card-bg, #fff)",
      boxShadow: "0 2px 8px rgba(0,0,0,0.05)",
      marginBottom: 16
    }}>
      <h2 style={{
        marginTop: 0,
        borderBottom: "2px solid #f0f0f0",
        paddingBottom: 8
      }}>{title}</h2>
      {children}
    </div>
  );
}

export default function App() {
  const [detections, setDetections] = useState([]);
  const [reviewData, setReviewData] = useState([]);
  const [inventory, setInventory] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [events, setEvents] = useState([]);
  const [latestScan, setLatestScan] = useState(null);
  const [selectedFile, setSelectedFile] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [darkMode, setDarkMode] = useState(false);

  // Toggle light/dark mode
  const toggleDarkMode = () => {
    setDarkMode(!darkMode);
    document.documentElement.style.setProperty('--card-bg', darkMode ? '#fff' : '#1e1e1e');
    document.documentElement.style.setProperty('--text-color', darkMode ? '#000' : '#eee');
  };

  async function load() {
    setError("");
    setLoading(true);
    try {
      const [inv, al, ev] = await Promise.all([
        fetch(`${API}/inventory`).then((r) => r.json()),
        fetch(`${API}/alerts`).then((r) => r.json()),
        fetch(`${API}/events?limit=20`).then((r) => r.json()),
      ]);
      setInventory(inv);
      setAlerts(al);
      setEvents(ev);
    } catch (e) {
      setError("Can't connect to Backend.");
    } finally {
      setLoading(false);
    }
  }

  async function loadDetections(scanId) {
    try {
      const data = await fetch(`${API}/scans/${scanId}/detections`).then(r => r.json());
      setDetections(data);
      setReviewData(data.map(d => ({
        original_label: d.label,
        final_label: d.label,
        included: true
      })));
    } catch (e) {
      console.error("Failed to load detections", e);
    }
  }

  async function submitReview() {
    setLoading(true);
    try {
      await fetch(`${API}/scans/${latestScan.id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: reviewData }),
      });
      alert("Inventory updated successfully!");
      load();
      setReviewData([]);
    } catch (e) {
      setError("Failed to submit review");
    } finally {
      setLoading(false);
    }
  }

  const updateReviewItem = (index, field, value) => {
    const newData = [...reviewData];
    newData[index][field] = value;
    setReviewData(newData);
  };

  async function uploadAndRunCV() {
    if (!selectedFile) return;

    setError("");
    setLatestScan(null);
    setDetections([]);
    setReviewData([]);
    setLoading(true);

    const formData = new FormData();
    formData.append("file", selectedFile);

    try {
      const response = await fetch(`${API}/door/closed/upload`, {
        method: "POST",
        body: formData,
      });

      const text = await response.text();
      if (!response.ok) throw new Error(text);

      const res = JSON.parse(text);
      if (!res.ok) throw new Error(res.error || "Backend returned ok=false");

      const newScan = await fetch(`${API}/scans/latest`).then(r => r.json());
      setLatestScan(newScan);
      await load();
    } catch (e) {
      setError(`Upload/Scan failed: ${e.message}`);
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (latestScan?.id) loadDetections(latestScan.id);
    else setDetections([]);
  }, [latestScan?.id]);

  useEffect(() => { load(); }, []);

  return (
    <div style={{
      maxWidth: 1400,
      margin: "24px auto",
      fontFamily: "system-ui, sans-serif",
      padding: "0 20px",
      color: "var(--text-color, #000)",
    }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Fridge 9000 Dashboard</h1>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={load} disabled={loading} style={{ padding: 8, cursor: "pointer" }}>
            {loading ? "Refreshing..." : "Refresh Data"}
          </button>
          <button onClick={toggleDarkMode} style={{ padding: 8, cursor: "pointer" }}>
            {darkMode ? "🌞 Light Mode" : "🌙 Dark Mode"}
          </button>
        </div>
      </header>

      {error && <div style={{ padding: 12, marginBottom: 16, backgroundColor: "#fee2e2", color: "#b91c1c", borderRadius: 6 }}>
        ⚠️ {error}
      </div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(350px, 1fr))", gap: 16 }}>

        {/* Door Control Card */}
        <Card title="Door Control">
          <input type="file" accept="image/*" onChange={e => setSelectedFile(e.target.files[0])} style={{ marginBottom: 12 }} />
          <button
            onClick={uploadAndRunCV}
            disabled={loading || !selectedFile}
            style={{
              padding: "10px 16px",
              backgroundColor: "#3b82f6",
              color: "white",
              border: "none",
              borderRadius: 6,
              cursor: loading || !selectedFile ? "not-allowed" : "pointer",
              width: "100%"
            }}
          >
            {loading ? "Processing..." : "📸 Upload & Run CV"}
          </button>
        </Card>

        {/* Database Control Card */}
        <Card title="Database Control">
          <div style={{ marginBottom: 16, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <button
              onClick={async () => {
                if (!window.confirm("Are you sure you want to reset the inventory?")) return;
                try {
                  const res = await fetch(`${API}/inventory/reset`, { method: "POST" });
                  const data = await res.json();
                  alert(data.message || "Reset done");
                  load();
                } catch (e) {
                  alert("Reset failed: " + e.message);
                }
              }}
              style={{
                padding: "10px 16px",
                backgroundColor: "#ef4444",
                color: "white",
                border: "none",
                borderRadius: 8,
                cursor: "pointer",
                fontWeight: "bold",
                flexGrow: 1,
                minWidth: 150
              }}
            >
              🗑 Reset Inventory
            </button>

            <input type="text" id="itemName" placeholder="Item Name" style={{ padding: 8, borderRadius: 6, border: "1px solid #ccc", flexGrow: 2, minWidth: 150 }} />
            <input type="number" id="itemQty" placeholder="Qty" style={{ padding: 8, borderRadius: 6, border: "1px solid #ccc", width: 80 }} />
            <select id="itemStatus" style={{ padding: 8, borderRadius: 6, border: "1px solid #ccc", minWidth: 100 }}>
              <option value="OK">OK</option>
              <option value="LOW">LOW</option>
              <option value="MISSING">MISSING</option>
            </select>

            <button
              onClick={async () => {
                const name = document.getElementById("itemName").value.trim();
                const quantity = parseInt(document.getElementById("itemQty").value);
                const status = document.getElementById("itemStatus").value;
                if (!name || isNaN(quantity)) return alert("Name & Qty required");
                const action = quantity > 0 ? "Added" : "Removed";
                try {
                  const res = await fetch(`${API}/inventory/manual`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ item_name: name, action, quantity }),
                  });
                  const data = await res.json();
                  if (!data.ok) throw new Error(data.error);
                  alert(`${name} updated! New qty: ${data.new_quantity}`);
                  load();
                } catch (e) {
                  alert("Failed: " + e.message);
                }
              }}
              style={{
                padding: "10px 16px",
                backgroundColor: "#3b82f6",
                color: "white",
                border: "none",
                borderRadius: 8,
                cursor: "pointer",
                fontWeight: "bold",
                minWidth: 140
              }}
            >
              ➕ Add / Update Item
            </button>
          </div>
        </Card>

        {/* Latest Scan Card */}
        <Card title="Latest Scan">
          {latestScan ? (
            <div>
              <p><strong>ID:</strong> {latestScan.id}</p>
              <p><strong>Time:</strong> {new Date(latestScan.created_at).toLocaleString()}</p>
              <p><strong>Image:</strong> {latestScan.image_ref}</p>
              <p><strong>Delta Skipped:</strong> {latestScan.delta_skipped ? "Yes" : "No"}</p>

              {detections.length > 0 ? (
                <div>
                  <p><strong>Detected Items:</strong></p>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {reviewData
                      .filter(d => d.included)
                      .map((d, idx) => (
                        <span key={idx} style={{
                          backgroundColor: "#10b981",
                          color: "white",
                          padding: "4px 8px",
                          borderRadius: 6,
                          fontSize: 12
                        }}>
                          {d.final_label}
                        </span>
                      ))}
                  </div>
                </div>
              ) : (
                <p style={{ color: "#b91c1c" }}>⚠️ No items detected</p>
              )}
            </div>
          ) : <p>No scans yet</p>}
        </Card>

        {/* Detections / Review Card */}
        {detections.length > 0 && (
          <Card title="Review Detections">
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ borderBottom: "1px solid #ddd", padding: 8 }}>Original</th>
                  <th style={{ borderBottom: "1px solid #ddd", padding: 8 }}>Final</th>
                  <th style={{ borderBottom: "1px solid #ddd", padding: 8 }}>Include</th>
                </tr>
              </thead>
              <tbody>
                {reviewData.map((d, idx) => (
                  <tr key={idx}>
                    <td style={{ padding: 8 }}>{d.original_label}</td>
                    <td style={{ padding: 8 }}>
                      <input
                        value={d.final_label}
                        onChange={e => updateReviewItem(idx, "final_label", e.target.value)}
                        style={{ padding: 4, width: "90%" }}
                      />
                    </td>
                    <td style={{ textAlign: "center" }}>
                      <input
                        type="checkbox"
                        checked={d.included}
                        onChange={e => updateReviewItem(idx, "included", e.target.checked)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button
              onClick={submitReview}
              style={{
                marginTop: 12,
                padding: "10px 16px",
                backgroundColor: "#10b981",
                color: "white",
                border: "none",
                borderRadius: 6,
                cursor: "pointer"
              }}
            >
              ✅ Submit Review
            </button>
          </Card>
        )}

        {/* Inventory Table */}
        <Card title="Inventory">
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ borderBottom: "1px solid #ddd", padding: 8 }}>Name</th>
                <th style={{ borderBottom: "1px solid #ddd", padding: 8 }}>Category</th>
                <th style={{ borderBottom: "1px solid #ddd", padding: 8 }}>Qty</th>
                <th style={{ borderBottom: "1px solid #ddd", padding: 8 }}>Status</th>
                <th style={{ borderBottom: "1px solid #ddd", padding: 8 }}>Last Updated</th>
              </tr>
            </thead>
            <tbody>
              {inventory.map(i => (
                <tr key={i.id}>
                  <td style={{ padding: 8 }}>{i.name}</td>
                  <td style={{ padding: 8 }}>{i.category}</td>
                  <td style={{ padding: 8 }}>{i.quantity}</td>
                  <td style={{ padding: 8 }}>{i.status}</td>
                  <td style={{ padding: 8 }}>{new Date(i.last_updated).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        {/* Alerts Table */}
        <Card title="Low Stock Alerts">
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ borderBottom: "1px solid #ddd", padding: 8 }}>Name</th>
                <th style={{ borderBottom: "1px solid #ddd", padding: 8 }}>Category</th>
                <th style={{ borderBottom: "1px solid #ddd", padding: 8 }}>Qty</th>
                <th style={{ borderBottom: "1px solid #ddd", padding: 8 }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map(a => (
                <tr key={a.id}>
                  <td style={{ padding: 8 }}>{a.name}</td>
                  <td style={{ padding: 8 }}>{a.category}</td>
                  <td style={{ padding: 8 }}>{a.quantity}</td>
                  <td style={{ padding: 8 }}>{a.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        {/* Events Table */}
        <Card title="Recent Events">
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ borderBottom: "1px solid #ddd", padding: 8 }}>Action</th>
                <th style={{ borderBottom: "1px solid #ddd", padding: 8 }}>Item</th>
                <th style={{ borderBottom: "1px solid #ddd", padding: 8 }}>Confidence</th>
                <th style={{ borderBottom: "1px solid #ddd", padding: 8 }}>Time</th>
              </tr>
            </thead>
            <tbody>
              {events.map(ev => (
                <tr key={ev.id}>
                  <td style={{ padding: 8 }}>{ev.action}</td>
                  <td style={{ padding: 8 }}>{ev.item_name}</td>
                  <td style={{ padding: 8 }}>{ev.confidence}</td>
                  <td style={{ padding: 8 }}>{new Date(ev.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

      </div>
    </div>
  );
}