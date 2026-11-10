import { AlarmClock, Contact as ContactIcon, Tags, UserPlus } from "lucide-react";
import type { ComponentType } from "react";

import type { ItemModule, ItemViewProps } from "@/items/types";

import { GroupsView } from "./GroupsView";
import { KeepInTouchView } from "./KeepInTouchView";
import { PeopleView } from "./PeopleView";
import { withPhotosLinks } from "./photosLink";
import { ContactsTheme, requestNewContact } from "./shared";
import type { ContactsData } from "./types";
import { vcardSelfCheck } from "./vcard";
import { csvSelfCheck } from "./csv";

/*
 * Contacts — an address book (everything Google Contacts keeps) and a
 * personal CRM (Monica / Clay / Dex): interactions, keep-in-touch rhythms,
 * birthdays, things to remember. Tabs: Contacts (A–Z + person, with
 * import / export / duplicates / settings under "More"), Keep in touch
 * (who's due, birthdays, dates), Groups (groups and tags). Each tab loads which
 * contacts are someone in your Photos (their face stands in for a missing
 * photo; see photosLink.tsx).
 */

if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__contactsSelfCheck = () => [...vcardSelfCheck(), ...csvSelfCheck()];
}

type View = ComponentType<ItemViewProps<ContactsData>>;

/** A tab with the Photos links loaded, and the suite's terracotta for its
 *  buttons and selection (the blue stays on the app mark only). */
function tab(Inner: View): View {
  const Linked = withPhotosLinks(Inner);
  function ContactsTab(props: ItemViewProps<ContactsData>) {
    return (
      <ContactsTheme>
        <Linked {...props} />
      </ContactsTheme>
    );
  }
  return ContactsTab;
}

const module: ItemModule<ContactsData> = {
  kind: "contacts",
  icon: ContactIcon,
  tabs: [
    { id: "people", label: "Contacts", icon: ContactIcon, View: tab(PeopleView) },
    { id: "touch", label: "Keep in touch", icon: AlarmClock, View: tab(KeepInTouchView) },
    { id: "groups", label: "Groups", icon: Tags, View: tab(GroupsView) },
  ],
  primaryAction: (h, { goTo }) =>
    h.canEdit
      ? {
          label: "Add contact",
          icon: <UserPlus className="h-4 w-4" />,
          onClick: () => {
            requestNewContact();
            goTo("people");
          },
        }
      : null,
};

export default module;
