import React from "react";
import ReactDOM from "react-dom/client";
import InventoryControlTower from "./InventoryControlTower.jsx";

// Shim for the window.storage API the dashboard expects (get/set returning promises)
if (!window.storage) {
  window.storage = {
    async get(key) {
      const value = localStorage.getItem(key);
      return value == null ? undefined : { value };
    },
    async set(key, value) {
      localStorage.setItem(key, value);
      return true;
    },
  };
}

// Render the Inventory Control Tower; the product-development dashboard
// remains available in ./App.jsx if needed.
ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <InventoryControlTower />
  </React.StrictMode>
);
