import { useEffect } from "react";

function App() {
  useEffect(() => {
    window.location.replace("/freshtrade");
  }, []);

  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      height: "100vh",
      background: "#0a0e17",
      color: "#64748b",
      fontSize: 18,
      fontFamily: "'DM Sans', system-ui, sans-serif"
    }}
    data-testid="text-loading">
      Loading FreshTrade...
    </div>
  );
}

export default App;
