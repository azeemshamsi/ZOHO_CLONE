import React from "react";

// A screen that fails to draw shows what went wrong (and a way back) instead of a blank page.
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error("[OrdexaGo] screen error", error, info?.componentStack);
  }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div style={{ padding: 24, maxWidth: 720, margin: "40px auto", fontFamily: "system-ui, sans-serif" }}>
        <h2 style={{ marginTop: 0 }}>Something on this screen failed to load</h2>
        <p>Please send a screenshot of this message to support so it can be fixed.</p>
        <pre style={{ whiteSpace: "pre-wrap", background: "#f1f5f9", padding: 12, borderRadius: 6, fontSize: 12 }}>
          {String(error?.message || error)}
          {"\n"}
          {String(error?.stack || "").split("\n").slice(0, 6).join("\n")}
        </pre>
        <button
          onClick={() => {
            this.setState({ error: null });
            window.location.reload();
          }}
          style={{ padding: "8px 14px", marginRight: 8 }}
        >
          Reload
        </button>
        <button onClick={() => (window.location.href = "/")} style={{ padding: "8px 14px" }}>
          Go to Home
        </button>
      </div>
    );
  }
}
