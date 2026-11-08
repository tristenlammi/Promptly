/**
 * Forms (the Google Forms replacement): a form is a Files document type
 * (``source_kind: "form"``) that opens in the form builder at
 * ``/files/form/:id``.
 *
 * The builder arrives with WP-F1.2. Until then this stays off: "New ▸ Form"
 * is hidden and a form in Files opens its preview (download) rather than a
 * page that doesn't exist yet. WP-F1.2 turns it on with the builder route.
 */
export const FORMS_BUILDER_READY = false;

/** A form's Drive file. */
export function isFormFile(file: { source_kind?: string | null }): boolean {
  return file.source_kind === "form";
}

/** The built-in templates ``POST /files/office {kind: "form", form_template}`` takes. */
export type FormTemplateKey = "rsvp" | "signup" | "feedback" | "contact" | "registration" | "order";
