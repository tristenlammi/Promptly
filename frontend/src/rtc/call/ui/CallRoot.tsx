/**
 * DM calls, app-wide (mounted once, signed in): rings in every tab, the
 * incoming call, the call screen (full or the small window), problems
 * starting a call, and the push's Answer button (``?call=…&answer=1``).
 */
import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { voiceHarnessEnabled } from "@/pages/dev/flags";
import { toast } from "@/store/toastStore";

import { hasAndroidCallsApp } from "../../voice/androidApp";
import { calls, callEngine } from "../actions";
import { useCallsLive } from "../live";
import { useCallStore } from "../store";
import { CallScreen } from "./CallScreen";
import { IncomingCall } from "./IncomingCall";

export function CallRoot() {
  useCallsLive();
  useAnswerFromPush();
  useStartProblems();
  useEffect(() => {
    // Developer builds and the e2e suite: the call state, for checking.
    if (voiceHarnessEnabled()) (window as unknown as { __calls: unknown }).__calls = { store: useCallStore, engine: callEngine };
  }, []);
  return (
    <>
      <CallScreen />
      <IncomingCall />
    </>
  );
}

/** The ring notification's Answer opens ``/rooms/r/<id>?call=<id>&answer=1``. */
function useAnswerFromPush() {
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const callId = q.get("call");
    if (!callId) return;
    const answer = q.get("answer") === "1";
    q.delete("call");
    q.delete("answer");
    const rest = q.toString();
    navigate({ pathname: location.pathname, search: rest ? `?${rest}` : "" }, { replace: true });
    // The Android app answered it (its call screen's "Show video"): this
    // page shows the video while the app keeps the sound.
    if (!answer && hasAndroidCallsApp()) {
      void calls.watch(callId);
      return;
    }
    if (!answer) return; // a plain tap: the incoming call shows if it still rings
    const ring = useCallStore.getState().incoming[callId];
    void calls.answer(callId, { video: ring?.media === "video", roomId: ring?.room_id ?? null, media: ring?.media ?? "audio" });
  }, [location.search, location.pathname, navigate]);
}

/** A call that couldn't start says why (the call screen isn't up). */
function useStartProblems() {
  const problem = useCallStore((s) => (s.status === "idle" ? s.problem : null));
  useEffect(() => {
    if (!problem) return;
    if (problem.kind === "refused" || problem.kind === "unavailable") toast.warning(problem.message || "This call can't be made right now.");
    else if (problem.kind === "connect-failed") toast.error("Couldn't connect the call. Check your connection, then try again.");
    else toast.error(problem.message || "Something went wrong with the call.");
    void calls.dismissProblem();
  }, [problem]);
}
