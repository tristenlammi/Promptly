import { AlarmClock, Contact as ContactIcon, Tags, UserPlus } from "lucide-react";

import type { ItemModule } from "@/items/types";

import { GroupsView } from "./GroupsView";
import { KeepInTouchView } from "./KeepInTouchView";
import { PeopleView } from "./PeopleView";
import { withPhotosLinks } from "./photosLink";
import { requestNewContact } from "./shared";
import type { ContactsData } from "./types";
import { vcardSelfCheck } from "./vcard";
import { csvSelfCheck } from "./csv";

/*
 * Contacts — an address book (everything Google Contacts keeps) and a
 * personal CRM (Monica / Clay / Dex): interactions, keep-in-touch rhythms,
 * birthdays, things to remember. Tabs: People (A–Z + person), Keep in
 * touch (who's due, birthdays, dates), Groups (groups, tags and the
 * import / export / duplicates / settings tools). Each tab loads which
 * contacts are someone in your Photos (their face stands in for a missing
 * photo; see photosLink.tsx).
 */

if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__contactsSelfCheck = () => [...vcardSelfCheck(), ...csvSelfCheck()];
}

const module: ItemModule<ContactsData> = {
  kind: "contacts",
  icon: ContactIcon,
  tabs: [
    { id: "people", label: "People", icon: ContactIcon, View: withPhotosLinks(PeopleView) },
    { id: "touch", label: "Keep in touch", icon: AlarmClock, View: withPhotosLinks(KeepInTouchView) },
    { id: "groups", label: "Groups", icon: Tags, View: withPhotosLinks(GroupsView) },
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
