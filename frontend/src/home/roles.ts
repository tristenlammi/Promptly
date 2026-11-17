import type { HomeRole } from "@/api/home";

/** What each role is called on the page. */
export const ROLE_WORDS: Record<HomeRole, string> = { owner: "Owner", coowner: "Co-owner", member: "Member" };

/** One line under the list of people: what this person can do here. */
export function whoRuns(role: HomeRole): string {
  if (role === "owner") return "You own this home. Co-owners can set it up like you; only you choose them, pass the home on or delete it.";
  if (role === "coowner") return "You're a co-owner: you can add devices, rooms, music and people. Only the owner chooses co-owners, passes the home on or deletes it.";
  return "You can use everything in this home. Its owner and co-owners add devices, rooms, music and people.";
}

/** Said where a member would otherwise find a setting-up control. */
export const ASK_OWNER = "The home's owner or a co-owner can change this.";

/** Who the owner can pass the home to: co-owners first, then members, each
 *  in the order they joined (the order the server lists them in). */
export function leavingChoices<T extends { id: string; role: HomeRole }>(members: T[], me: string): T[] {
  const others = members.filter((m) => m.id !== me && m.role !== "owner");
  return [...others.filter((m) => m.role === "coowner"), ...others.filter((m) => m.role !== "coowner")];
}
