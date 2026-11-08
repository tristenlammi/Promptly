/**
 * Forms (the Google Forms replacement): a form is a Files document type
 * (``source_kind: "form"``) that opens in the form builder at
 * ``/files/form/:id``. The Forms home (``/forms``) lists them.
 *
 * ``FORMS_BUILDER_READY`` turned on with the builder (WP-F1.2): it shows
 * "New ▸ Form" in Files and on the Files home, and opens forms in the
 * builder rather than a preview.
 */
export const FORMS_BUILDER_READY = true;

/** A form's Drive file. */
export function isFormFile(file: { source_kind?: string | null }): boolean {
  return file.source_kind === "form";
}

/** The built-in templates ``POST /files/office {kind: "form", form_template}`` takes. */
export type FormTemplateKey = "rsvp" | "signup" | "feedback" | "contact" | "registration" | "order";

/** The builder's address for a form file. */
export function formBuilderPath(fileId: string): string {
  return `/files/form/${fileId}`;
}
