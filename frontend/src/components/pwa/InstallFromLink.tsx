import { useSearchParams } from "react-router-dom";

import { InstallPromptCard } from "@/components/pwa/InstallPromptCard";

/** The install card over the page when it's opened with ``?install=1``
 *  (the Install apps page sends people here). The page must already link
 *  the app's own manifest — the browser installs whatever it links. */
export function InstallFromLink({
  appName,
  iconSrc,
  description,
}: {
  appName: string;
  iconSrc: string;
  description?: string;
}) {
  const [params, setParams] = useSearchParams();
  if (params.get("install") !== "1") return null;

  const close = () => {
    const next = new URLSearchParams(params);
    next.delete("install");
    setParams(next, { replace: true });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[max(env(safe-area-inset-top,0px),4rem)]"
      onClick={close}
    >
      <div className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <InstallPromptCard appName={appName} iconSrc={iconSrc} description={description} onClose={close} />
      </div>
    </div>
  );
}
