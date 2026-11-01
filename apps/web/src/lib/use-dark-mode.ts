"use client";

import { useEffect, useState } from "react";

/** The app themes with a `dark` class on <html>; MUI needs to be told, or its axis text stays dark. */
export function useDarkMode() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setDark(root.classList.contains("dark") || root.dataset.theme === "dark");

    sync();
    const observer = new MutationObserver(sync);

    observer.observe(root, { attributeFilter: ["class", "data-theme"], attributes: true });
    return () => observer.disconnect();
  }, []);

  return dark;
}

