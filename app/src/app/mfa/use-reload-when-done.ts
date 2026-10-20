"use client";

import { useEffect } from "react";
import type { MfaFormState } from "./actions";

// A full page load after the code is accepted, so no page cached while the session was aal1 is reused.
export function useReloadWhenDone(state: MfaFormState) {
  useEffect(() => {
    if (state.status === "done") window.location.replace(state.next ?? "/");
  }, [state]);
}
