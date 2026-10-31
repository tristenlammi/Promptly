import { AlarmClock, Contact as ContactIcon, Tags, UserPlus } from "lucide-react";

import type { ItemModule } from "@/items/types";

import { GroupsView } from "./GroupsView";
import { KeepInTouchView } from "./KeepInTouchView";
import { PeopleView } from "./PeopleView";
import { requestNewContact } from "./shared";
import type { ContactsData } from "./types";
import { vcardSelfCheck } from "./vcard";
import { csvSelfCheck } from "./csv";

/*
 * Contacts — an address book (everything Google Contacts keeps) and a
 * personal CRM (Monica / Clay / Dex): interactions, keep-in-touch rhythms,
 * birthdays, things to remember. Tabs: People (A–Z + person), Keep in
 * touch (who's due, birthdays, dates), Groups (groups, tags and the
 * import / export / duplicates / settings tools).
 */

if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__contactsSelfCheck = () => [...vcardSelfCheck(), ...csvSelfCheck()];
}

const module: ItemModule<ContactsData> = {
  kind: "contacts",
  icon: ContactIcon,
  tabs: [
    { id: "people", label: "People", icon: ContactIcon, View: PeopleView },
    { id: "touch", label: "Keep in touch", icon: AlarmClock, View: KeepInTouchView },
    { id: "groups", label: "Groups", icon: Tags, View: GroupsView },
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
