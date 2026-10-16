import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Download, Loader2, Printer, Settings2 } from "lucide-react";

import { documentsApi } from "@/api/documents";
import { Button } from "@/components/shared/Button";
import { Modal } from "@/components/shared/Modal";
import { apiErrorMessage } from "@/utils/apiError";
import { toast } from "@/store/toastStore";

const PdfCanvasPreview = lazy(() =>
  import("@/components/files/PdfCanvasPreview").then((m) => ({ default: m.PdfCanvasPreview }))
);

/**
 * Print preview (WP-6.4): the document's PDF — rendered by the server under
 * its page setup — shown in the pdf.js viewer. What you see is what prints
 * and what downloads. ``version`` changes whenever the page setup does, so
 * the preview follows it.
 */
export function PrintPreviewModal({
  open,
  fileId,
  title,
  version,
  onClose,
  onPageSetup,
}: {
  open: boolean;
  fileId: string;
  title: string;
  version: string;
  onClose: () => void;
  onPageSetup: () => void;
}) {
  const [pdf, setPdf] = useState<{ data: ArrayBuffer; filename: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (!open) {
      setPdf(null);
      setError(null);
      return;
    }
    const mine = ++seq.current;
    setPdf(null);
    setError(null);
    // A page-setup change reaches the server over the collab socket; give
    // it a moment before asking for the PDF.
    const t = window.setTimeout(() => {
      documentsApi
        .download(fileId, "pdf")
        .then(async ({ blob, filename }) => {
          const data = await blob.arrayBuffer();
          if (seq.current === mine) setPdf({ data, filename });
        })
        .catch((e) => {
          if (seq.current === mine) setError(apiErrorMessage(e, "Couldn't make the PDF."));
        });
    }, 250);
    return () => window.clearTimeout(t);
  }, [open, fileId, version]);

  const download = () => {
    if (!pdf) return;
    const url = URL.createObjectURL(new Blob([pdf.data], { type: "application/pdf" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = pdf.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const print = async () => {
    if (!pdf || printing) return;
    setPrinting(true);
    try {
      const { printPdf } = await import("@/lib/printPdf");
      await printPdf(pdf.data, title);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't print."));
    } finally {
      setPrinting(false);
    }
  };

  const loading = !pdf && !error;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Print preview"
      widthClass="max-w-4xl"
      footer={
        <>
          <Button variant="ghost" leftIcon={<Settings2 className="h-4 w-4" />} onClick={onPageSetup} className="mr-auto">
            Page setup…
          </Button>
          <Button leftIcon={<Download className="h-4 w-4" />} onClick={download} disabled={!pdf}>
            Download PDF
          </Button>
          <Button
            variant="primary"
            leftIcon={printing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />}
            onClick={() => void print()}
            disabled={!pdf || printing}
          >
            Print
          </Button>
        </>
      }
    >
      <div className="flex h-[62vh] flex-col overflow-hidden rounded-md bg-neutral-200 dark:bg-neutral-800" data-testid="print-preview">
        {error ? (
          <div className="m-auto max-w-sm text-center text-sm text-red-500">{error}</div>
        ) : loading ? (
          <div className="m-auto flex items-center gap-2 text-sm text-[var(--text-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" /> Making the PDF…
          </div>
        ) : (
          <Suspense fallback={<Loader2 className="m-auto h-5 w-5 animate-spin text-[var(--text-muted)]" />}>
            <PdfCanvasPreview key={pdf!.data.byteLength + version} data={pdf!.data} filename={pdf!.filename} />
          </Suspense>
        )}
      </div>
    </Modal>
  );
}
