/**
 * DM calls, app-wide (mounted once, signed in): rings in every tab, the
 * incoming call, the call screen (full or the small window), problems
 * starting a call, the push's Answer button (``?call=…&answer=1``), and a
 * call the Promptly Android app couldn't take (``#call-no-app``).
 */
import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { voiceHarnessEnabled } from "@/pages/dev/flags";
import { toast } from "@/store/toastStore";

import { forgetAndroidCallsApp, hasAndroidCallsApp, onNoCallApp } from "../../voice/androidApp";
import { calls, callEngine } from "../actions";
import { useCallsLive } from "../live";
import { useCallStore } from "../store";
import { CallScreen } from "./CallScreen";
import { IncomingCall } from "./IncomingCall";

export function CallRoot() {
  useCallsLive();
  useAnswerFromPush();
  useStartProblems();
  useNoCallApp();
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

/**
 * A call started on this phone was handed to the Promptly app, but the app
 * isn't there any more (Chrome came back to ``#call-no-app``): this page
 * holds the call instead, and calls ring here again from now on.
 */
function useNoCallApp() {
  useEffect(
    () =>
      onNoCallApp(() => {
        forgetAndroidCallsApp();
        const s = useCallStore.getState();
        if (!s.callId || !s.phone) return;
        toast.info("The Promptly app couldn't take the call, so this page holds it. Keep it open while you talk.");
        void callEngine().then((e) => e.takeHere(s.callId as string));
      }),
    [],
  );
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
