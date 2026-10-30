import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { newId } from "../db/schema";
import { ensureContact, findContact } from "../contacts/store";

export type ContactRole = "recipient" | "contributor";

export type TelegramContributorStatus = "active" | "revoked";
export type TelegramContributorInviteStatus = "pending" | "claimed" | "revoked";

export interface TelegramContributor {
  contact_id: string;
  role: ContactRole;
  private_chat_id: string;
  username: string | null;
  delivery_status: "ready" | "opted_out" | "blocked";
  telegram_user_id: string;
  counterparty_name: string;
  status: TelegramContributorStatus;
  invite_id: string | null;
  activated_at: string;
  revoked_at: string | null;
  updated_at: string;
}

export interface TelegramContributorInvite {
  contact_id: string;
  role: ContactRole;
  expected_username: string | null;
  id: string;
  token_hash: string;
  contributor_name: string;
  status: TelegramContributorInviteStatus;
  expires_at: string;
  claimed_by_telegram_user_id: string | null;
  created_by: string;
  created_at: string;
  claimed_at: string | null;
}

export interface CreatedTelegramContributorInvite {
  contact_id: string;
  role: ContactRole;
  invite_id: string;
  contributor_name: string;
  expires_at: string;
  claim_token: string;
  claim_command: string;
  deep_link: string | null;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function normalizedName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

function nowIso(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

export function createTelegramContributorInvite(
  db: Database.Database,
  input: {
    contributor_name: string;
    expires_hours?: number;
    created_by: string;
    now?: Date;
  },
): CreatedTelegramContributorInvite {
  return createContactInvite(db, {
    ...input,
    name: input.contributor_name,
    role: "contributor",
  });
}

export function createContactInvite(
  db: Database.Database,
  input: {
    name: string;
    role?: ContactRole;
    expected_username?: string;
    expires_hours?: number;
    created_by: string;
    now?: Date;
  },
): CreatedTelegramContributorInvite {
  const contact = ensureContact(db, input.name);
  const contributorName = contact.display_name;
  const role = input.role ?? "recipient";
  if (!["recipient", "contributor"].includes(role))
    throw new Error("Invalid contact role");
  const username =
    input.expected_username?.replace(/^@/, "").toLowerCase() ?? null;
  if (username && !/^[a-z0-9_]{5,32}$/.test(username))
    throw new Error("Invalid Telegram handle");
  const createdBy = input.created_by.trim();
  const expiresHours = input.expires_hours ?? 24;
  if (!contributorName) throw new Error("contributor_name is required");
  if (!createdBy) throw new Error("created_by is required");
  if (
    !Number.isInteger(expiresHours) ||
    expiresHours < 1 ||
    expiresHours > 168
  ) {
    throw new Error("expires_hours must be a whole number between 1 and 168");
  }
  const existing = db
    .prepare(
      `SELECT telegram_user_id FROM telegram_contributors
       WHERE status = 'active' AND contact_id = ?
       LIMIT 1`,
    )
    .get(contact.id) as { telegram_user_id: string } | undefined;
  if (existing)
    throw new Error(`${contributorName} already has active Telegram access`);

  const createdAt = nowIso(input.now);
  const expiresAt = new Date(
    new Date(createdAt).getTime() + expiresHours * 60 * 60 * 1000,
  ).toISOString();
  const token = randomBytes(24).toString("base64url");
  const inviteId = newId();
  db.transaction(() => {
    db.prepare(
      "UPDATE telegram_contributor_invites SET status = 'revoked' WHERE contact_id = ? AND status = 'pending'",
    ).run(contact.id);
    db.prepare(
      `INSERT INTO telegram_contributor_invites (
      id, token_hash, contributor_name, status, expires_at, created_by, created_at, contact_id, role, expected_username
    ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
    ).run(
      inviteId,
      tokenHash(token),
      contributorName,
      expiresAt,
      createdBy,
      createdAt,
      contact.id,
      role,
      username,
    );
    db.prepare("UPDATE contacts SET kind = 'person' WHERE id = ?").run(
      contact.id,
    );
    auditContact(db, contact.id, "invite_created", createdBy, createdAt);
  })();

  const botUsername =
    process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "") || null;
  return {
    contact_id: contact.id,
    role,
    invite_id: inviteId,
    contributor_name: contributorName,
    expires_at: expiresAt,
    claim_token: token,
    claim_command: `/join ${token}`,
    deep_link: botUsername
      ? `https://t.me/${botUsername}?start=plutus_${token}`
      : null,
  };
}

export function getActiveTelegramContributor(
  db: Database.Database,
  telegramUserId: string,
): TelegramContributor | undefined {
  const connection = getTelegramRecipient(db, telegramUserId);
  return connection?.role === "contributor" ? connection : undefined;
}

export function getTelegramRecipient(
  db: Database.Database,
  telegramUserId: string,
): TelegramContributor | undefined {
  return db
    .prepare(
      `SELECT t.*, c.display_name AS counterparty_name FROM telegram_contributors t
       JOIN contacts c ON c.id = t.contact_id
       WHERE telegram_user_id = ? AND status = 'active'`,
    )
    .get(telegramUserId) as TelegramContributor | undefined;
}

export function claimTelegramContributorInvite(
  db: Database.Database,
  input: {
    claim_token: string;
    telegram_user_id: string;
    owner_telegram_user_id: string;
    username?: string;
    now?: Date;
  },
): {
  contributor: TelegramContributor;
  invite: TelegramContributorInvite;
  was_existing: boolean;
} {
  const token = input.claim_token.trim();
  const telegramUserId = input.telegram_user_id.trim();
  const ownerTelegramUserId = input.owner_telegram_user_id.trim();
  if (!token) throw new Error("claim token is required");
  if (!/^\d+$/.test(telegramUserId))
    throw new Error("Telegram user ID must be numeric");
  if (telegramUserId === ownerTelegramUserId) {
    throw new Error("the owner cannot claim a contributor invitation");
  }
  const claimedAt = nowIso(input.now);

  return db.transaction(() => {
    const invite = db
      .prepare(
        "SELECT * FROM telegram_contributor_invites WHERE token_hash = ?",
      )
      .get(tokenHash(token)) as TelegramContributorInvite | undefined;
    if (!invite) throw new Error("invitation is invalid or expired");

    if (
      invite.status === "claimed" &&
      invite.claimed_by_telegram_user_id === telegramUserId
    ) {
      const contributor = getTelegramRecipient(db, telegramUserId);
      if (contributor?.contact_id === invite.contact_id)
        return { contributor, invite, was_existing: true };
    }
    if (invite.status !== "pending" || invite.expires_at <= claimedAt) {
      if (invite.status === "pending") {
        db.prepare(
          "UPDATE telegram_contributor_invites SET status = 'revoked' WHERE id = ?",
        ).run(invite.id);
      }
      throw new Error("invitation is invalid or expired");
    }
    const username = input.username?.replace(/^@/, "").toLowerCase() ?? null;
    if (invite.expected_username && username !== invite.expected_username) {
      throw new Error(
        "Telegram account does not match the invitation; ask Aniket to review it",
      );
    }

    const existingIdentity = db
      .prepare("SELECT * FROM telegram_contributors WHERE telegram_user_id = ?")
      .get(telegramUserId) as TelegramContributor | undefined;
    if (existingIdentity?.status === "active") {
      throw new Error("this Telegram account already has contributor access");
    }
    if (existingIdentity && existingIdentity.contact_id !== invite.contact_id) {
      throw new Error(
        "This Telegram identity is linked to a different contact",
      );
    }
    const nameCollision = db
      .prepare(
        `SELECT telegram_user_id FROM telegram_contributors
         WHERE contact_id = ?
         LIMIT 1`,
      )
      .get(invite.contact_id) as { telegram_user_id: string } | undefined;
    if (nameCollision && nameCollision.telegram_user_id !== telegramUserId) {
      throw new Error(
        "that contributor name is already linked to another Telegram account",
      );
    }

    if (existingIdentity) {
      db.prepare(
        `UPDATE telegram_contributors SET
          counterparty_name = ?, status = 'active', invite_id = ?,
          activated_at = ?, revoked_at = NULL, updated_at = ?, role = ?,
          private_chat_id = ?, username = ?, delivery_status = 'ready'
         WHERE telegram_user_id = ?`,
      ).run(
        invite.contributor_name,
        invite.id,
        claimedAt,
        claimedAt,
        invite.role,
        telegramUserId,
        username,
        telegramUserId,
      );
    } else {
      db.prepare(
        `INSERT INTO telegram_contributors (
          telegram_user_id, counterparty_name, status, invite_id,
          activated_at, revoked_at, updated_at, contact_id, role, private_chat_id, username
        ) VALUES (?, ?, 'active', ?, ?, NULL, ?, ?, ?, ?, ?)`,
      ).run(
        telegramUserId,
        invite.contributor_name,
        invite.id,
        claimedAt,
        claimedAt,
        invite.contact_id,
        invite.role,
        telegramUserId,
        username,
      );
    }
    const claimed = db
      .prepare(
        `UPDATE telegram_contributor_invites SET
        status = 'claimed', claimed_by_telegram_user_id = ?, claimed_at = ?
       WHERE id = ? AND status = 'pending'`,
      )
      .run(telegramUserId, claimedAt, invite.id);
    if (claimed.changes !== 1)
      throw new Error("invitation was already claimed");
    bumpContact(db, invite.contact_id);
    auditContact(
      db,
      invite.contact_id,
      "invite_claimed",
      `telegram:${telegramUserId}`,
      claimedAt,
    );

    return {
      contributor: getTelegramRecipient(
        db,
        telegramUserId,
      ) as TelegramContributor,
      invite: db
        .prepare("SELECT * FROM telegram_contributor_invites WHERE id = ?")
        .get(invite.id) as TelegramContributorInvite,
      was_existing: false,
    };
  })();
}

export function listTelegramContributors(
  db: Database.Database,
  input: { include_revoked?: boolean } = {},
): Array<{
  contributor_name: string;
  status: TelegramContributorStatus;
  activated_at: string;
  revoked_at: string | null;
}> {
  const rows = db
    .prepare(
      `SELECT c.display_name AS counterparty_name, t.status, t.activated_at, t.revoked_at
       FROM telegram_contributors t JOIN contacts c ON c.id = t.contact_id
       WHERE role = 'contributor' ${input.include_revoked ? "" : "AND status = 'active'"}
       ORDER BY c.display_name COLLATE NOCASE, activated_at`,
    )
    .all() as Array<{
    counterparty_name: string;
    status: TelegramContributorStatus;
    activated_at: string;
    revoked_at: string | null;
  }>;
  return rows.map((row) => ({
    contributor_name: row.counterparty_name,
    status: row.status,
    activated_at: row.activated_at,
    revoked_at: row.revoked_at,
  }));
}

export function countActiveTelegramContributors(db: Database.Database): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM telegram_contributors WHERE status = 'active' AND role = 'contributor'",
      )
      .get() as { count: number }
  ).count;
}

export function revokeTelegramContributor(
  db: Database.Database,
  input: { contributor_name: string; now?: Date },
): { contributor_name: string; status: "revoked"; revoked_at: string } {
  const contributorName = normalizedName(input.contributor_name);
  if (!contributorName) throw new Error("contributor_name is required");
  const matches = db
    .prepare(
      `SELECT * FROM telegram_contributors
       WHERE status = 'active' AND contact_id = ?`,
    )
    .all(findContact(db, contributorName)?.id ?? "") as TelegramContributor[];
  if (matches.length === 0)
    throw new Error(`no active contributor named ${contributorName}`);
  if (matches.length > 1)
    throw new Error(
      `multiple active contributors are named ${contributorName}`,
    );
  const revokedAt = nowIso(input.now);
  setContactAccess(db, matches[0].contact_id, "revoked", "owner", input.now);
  return {
    contributor_name: matches[0].counterparty_name,
    status: "revoked",
    revoked_at: revokedAt,
  };
}

function bumpContact(db: Database.Database, id: string): void {
  db.prepare("UPDATE contacts SET version = version + 1 WHERE id = ?").run(id);
}

function auditContact(
  db: Database.Database,
  id: string,
  action: string,
  actor: string,
  at = nowIso(),
): void {
  db.prepare(
    "INSERT INTO contact_audit(contact_id,action,actor,created_at) VALUES (?,?,?,?)",
  ).run(id, action, actor, at);
}

export function setContactAccess(
  db: Database.Database,
  contactId: string,
  role: ContactRole | "revoked",
  actor: string,
  now?: Date,
): void {
  if (!["recipient", "contributor", "revoked"].includes(role))
    throw new Error("Invalid role");
  const connection = db
    .prepare("SELECT * FROM telegram_contributors WHERE contact_id = ?")
    .get(contactId) as TelegramContributor | undefined;
  if (!connection) {
    if (role !== "revoked" || !findContact(db, contactId))
      throw new Error("Contact must accept an invitation first");
    db.transaction(() => {
      db.prepare(
        "UPDATE telegram_contributor_invites SET status='revoked' WHERE contact_id=? AND status='pending'",
      ).run(contactId);
      bumpContact(db, contactId);
      auditContact(db, contactId, "invitation_revoked", actor, nowIso(now));
    })();
    return;
  }
  if (connection.status !== "active" && role !== "revoked")
    throw new Error("Use a fresh invitation to restore revoked access");
  db.transaction(() => {
    const at = nowIso(now);
    db.prepare(
      `UPDATE telegram_contributors SET role = ?, status = ?, revoked_at = ?, updated_at = ? WHERE contact_id = ?`,
    ).run(
      role === "revoked" ? connection.role : role,
      role === "revoked" ? "revoked" : "active",
      role === "revoked" ? at : null,
      at,
      contactId,
    );
    db.prepare(
      "UPDATE telegram_contributor_invites SET status = 'revoked' WHERE contact_id = ? AND status = 'pending'",
    ).run(contactId);
    bumpContact(db, contactId);
    auditContact(db, contactId, `access:${role}`, actor, at);
  })();
}

export function setRecipientDelivery(
  db: Database.Database,
  telegramUserId: string,
  status: "ready" | "opted_out" | "blocked",
): void {
  const connection = getTelegramRecipient(db, telegramUserId);
  if (!connection) throw new Error("No active Telegram connection");
  db.transaction(() => {
    db.prepare(
      "UPDATE telegram_contributors SET delivery_status = ? WHERE telegram_user_id = ?",
    ).run(status, telegramUserId);
    bumpContact(db, connection.contact_id);
    auditContact(
      db,
      connection.contact_id,
      `delivery:${status}`,
      `telegram:${telegramUserId}`,
    );
  })();
}
