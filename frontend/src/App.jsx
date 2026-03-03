import { useEffect, useState } from "react";

const API = "http://localhost:8000";

function Card({ title, children }) {
  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 16, backgroundColor: "#fff" }}>
      <h2 style={{ marginTop: 0, borderBottom: "2px solid #f0f0f0", paddingBottom: 8 }}>{title}</h2>
      {children}
    </div>
  );
}

export default function App() {
  const [detections, setDetections] = useState([]);
  const [reviewData, setReviewData] = useState([]); // רשימת הפריטים לעריכה
  const [inventory, setInventory] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [events, setEvents] = useState([]);
  const [latestScan, setLatestScan] = useState(null);
  const [selectedFile, setSelectedFile] = useState(null); // State לקובץ הנבחר
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

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
    // שים לב: הורדנו את setLatestScan מפה כדי שלא יטען היסטוריה בטעינת דף
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
    // הכנה של המידע ל-Review (ברירת מחדל: הכל כלול)
    setReviewData(data.map(d => ({
      original_label: d.label,
      final_label: d.label,
      included: true
    })));
  } catch (e) {
    console.error("Failed to load detections", e);
  }
}

// שליחת הביקורת לשרת
async function submitReview() {
  setLoading(true);
  try {
    await fetch(`${API}/scans/${latestScan.id}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: reviewData }),
    });
    alert("Inventory updated successfully!");
    load(); // רענון מלא של המלאי
    setReviewData([]); // איפוס
  } catch (e) {
    setError("Failed to submit review");
  } finally {
    setLoading(false);
  }
}

// עדכון שדה ספציפי בסטייט של ה-Review
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

    const text = await response.text(); // נקרא טקסט כדי לא להיתקע על JSON
    if (!response.ok) {
      throw new Error(text);
    }

    const res = JSON.parse(text);

    if (!res.ok) {
      throw new Error(res.error || "Backend returned ok=false");
    }

    const newScan = await fetch(`${API}/scans/latest`).then((r) => r.json());
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
  if (latestScan?.id) {
    loadDetections(latestScan.id);
  } else {
    // אם אין סריקה (למשל אחרי איפוס), ננקה את הזיהויים
    setDetections([]);
    setReviewData([]);
  }
}, [latestScan?.id]); // מעקב רק אחרי ה-ID ולא אחרי האובייקט כולו

useEffect(() => {
  load();
}, []);

  return (
    <div style={{ maxWidth: 1000, margin: "24px auto", fontFamily: "system-ui, sans-serif", padding: "0 20px" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Fridge 9000 Dashboard</h1>
        <button onClick={load} disabled={loading} style={{ padding: "8px 16px", cursor: "pointer" }}>
          {loading ? "Refreshing..." : "Refresh Data"}
        </button>
      </header>

      {/* אזור שליטה חדש: העלאת קובץ (Door Control) */}
      <div style={{ marginBottom: 20, padding: 15, backgroundColor: "#f8f9fa", borderRadius: 8 }}>
        <h3 style={{ marginTop: 0 }}>Door Control (Upload & Run CV)</h3>
        <div style={{ marginBottom: 16 }}>
          <input
            type="file"
            accept="image/*"
            onChange={(e) => setSelectedFile(e.target.files[0])}
            style={{ marginBottom: 8 }}
          />
          <br />
          <button 
            onClick={uploadAndRunCV}
            disabled={loading || !selectedFile}
            style={{ 
              padding: "10px 20px", 
              cursor: "pointer", 
              backgroundColor: "#3b82f6", 
              color: "white", 
              border: "none", 
              borderRadius: 6,
              opacity: (loading || !selectedFile) ? 0.6 : 1
            }}
          >
            {loading ? "Processing..." : "📸 Upload & Run CV"}
          </button>
        </div>
      </div>

      {error && (
        <div style={{ padding: 12, marginBottom: 16, backgroundColor: "#fee2e2", color: "#b91c1c", borderRadius: 6 }}>
          ⚠️ {error}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 16 }}>
        
        <Card title="Last Scan">
          {latestScan?.id ? (
            <div style={{ fontSize: "0.95rem" }}>
              <div><b>Scan ID:</b> {latestScan.id}</div>
              <div><b>Time:</b> {new Date(latestScan.created_at).toLocaleString()}</div>
              <div><b>Delta skipped:</b> {String(latestScan.delta_skipped)}</div>
              <div style={{ wordBreak: "break-all" }}><b>image_ref:</b> {latestScan.image_ref || "—"}</div>
            </div>
          ) : (
            <div>No scans yet</div>
          )}
        </Card>
          <Card title={`Review Scan #${latestScan?.id || '?'}`}>
  {!latestScan ? (
    <p>No scan selected for review</p>
  ) : reviewData.length === 0 ? (
    <p>No detections found in this scan</p>
  ) : (
    <div>
      <table width="100%" style={{ fontSize: "0.85rem", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #eee" }}>
            <th>In?</th>
            <th>Original</th>
            <th>Correction</th>
          </tr>
        </thead>
        <tbody>
          {reviewData.map((item, idx) => (
            <tr key={idx} style={{ borderBottom: "1px solid #fafafa" }}>
              <td>
                <input
                  type="checkbox"
                  checked={item.included}
                  onChange={(e) => updateReviewItem(idx, 'included', e.target.checked)}
                />
              </td>
              <td style={{ padding: "8px 0" }}>
                {item.original_label} 
                <small style={{ color: "#999", display: "block" }}>
                  conf: {Math.round(detections[idx]?.confidence * 100)}%
                </small>
              </td>
              <td>
                <input
                  type="text"
                  value={item.final_label}
                  onChange={(e) => updateReviewItem(idx, 'final_label', e.target.value)}
                  style={{ width: "80px", padding: "2px 4px" }}
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
          width: "100%", 
          padding: 8, 
          backgroundColor: "#10b981", 
          color: "white", 
          border: "none", 
          borderRadius: 6,
          cursor: "pointer"
        }}
      >
        ✅ Apply to Inventory
      </button>
    </div>
  )}
</Card>
        <Card title="Current Inventory">
          <table width="100%" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #eee" }}>
                <th align="left">Item</th>
                <th align="left">Qty</th>
                <th align="left">Status</th>
              </tr>
            </thead>
            <tbody>
              {inventory.map((x) => (
                <tr key={x.id} style={{ borderBottom: "1px solid #fafafa" }}>
                  <td style={{ padding: "8px 0" }}>{x.name}</td>
                  <td>{x.quantity}</td>
                  <td style={{ 
                    color: x.status === "MISSING" ? "red" : x.status === "LOW" ? "orange" : "green",
                    fontWeight: "bold"
                  }}>
                    {x.status}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card title="Low-Stock Alerts">
          {alerts.length === 0 ? (
            <div style={{ color: "#059669" }}>All systems green 🎉</div>
          ) : (
            <ul style={{ paddingLeft: 20 }}>
              {alerts.map((a) => (
                <li key={a.id} style={{ color: "#dc2626", marginBottom: 4 }}>
                  {a.name} — <b>{a.status}</b>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Recent Activity">
          <div style={{ maxHeight: 300, overflowY: "auto" }}>
            {events.length === 0 ? (
              <div>No events yet</div>
            ) : (
              <ul style={{ paddingLeft: 20, fontSize: "0.9rem" }}>
                {events.map((e) => (
                  <li key={e.id} style={{ marginBottom: 8 }}>
                    <strong>{e.action}</strong> {e.item_name && `: ${e.item_name}`}
                    <br />
                    <small style={{ color: "#666" }}>{new Date(e.created_at).toLocaleTimeString()}</small>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}