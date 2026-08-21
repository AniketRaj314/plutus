import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { newId } from "../db/schema";

export type TelegramContributorStatus = "active" | "revoked";
export type TelegramContributorInviteStatus = "pending" | "claimed" | "revoked";

export interface TelegramContributor {
  telegram_user_id: string;
  counterparty_name: string;
  status: TelegramContributorStatus;
  invite_id: string | null;
  activated_at: string;
  revoked_at: string | null;
  updated_at: string;
}

export interface TelegramContributorInvite {
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
  }
): CreatedTelegramContributorInvite {
  const contributorName = normalizedName(input.contributor_name);
  const createdBy = input.created_by.trim();
  const expiresHours = input.expires_hours ?? 24;
  if (!contributorName) throw new Error("contributor_name is required");
  if (!createdBy) throw new Error("created_by is required");
  if (!Number.isInteger(expiresHours) || expiresHours < 1 || expiresHours > 168) {
    throw new Error("expires_hours must be a whole number between 1 and 168");
  }
  const existing = db
    .prepare(
      `SELECT telegram_user_id FROM telegram_contributors
       WHERE status = 'active' AND counterparty_name = ? COLLATE NOCASE
       LIMIT 1`
    )
    .get(contributorName) as { telegram_user_id: string } | undefined;
  if (existing) throw new Error(`${contributorName} already has active Telegram access`);

  const createdAt = nowIso(input.now);
  const expiresAt = new Date(
    new Date(createdAt).getTime() + expiresHours * 60 * 60 * 1000
  ).toISOString();
  const token = randomBytes(24).toString("base64url");
  const inviteId = newId();
  db.prepare(
    `INSERT INTO telegram_contributor_invites (
      id, token_hash, contributor_name, status, expires_at, created_by, created_at
    ) VALUES (?, ?, ?, 'pending', ?, ?, ?)`
  ).run(inviteId, tokenHash(token), contributorName, expiresAt, createdBy, createdAt);

  const botUsername = process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "") || null;
  return {
    invite_id: inviteId,
    contributor_name: contributorName,
    expires_at: expiresAt,
    claim_token: token,
    claim_command: `/join ${token}`,
    deep_link: botUsername ? `https://t.me/${botUsername}?start=plutus_${token}` : null,
  };
}

export function getActiveTelegramContributor(
  db: Database.Database,
  telegramUserId: string
): TelegramContributor | undefined {
  return db
    .prepare(
      `SELECT * FROM telegram_contributors
       WHERE telegram_user_id = ? AND status = 'active'`
    )
    .get(telegramUserId) as TelegramContributor | undefined;
}

export function claimTelegramContributorInvite(
  db: Database.Database,
  input: {
    claim_token: string;
    telegram_user_id: string;
    owner_telegram_user_id: string;
    now?: Date;
  }
): {
  contributor: TelegramContributor;
  invite: TelegramContributorInvite;
  was_existing: boolean;
} {
  const token = input.claim_token.trim();
  const telegramUserId = input.telegram_user_id.trim();
  const ownerTelegramUserId = input.owner_telegram_user_id.trim();
  if (!token) throw new Error("claim token is required");
  if (!/^\d+$/.test(telegramUserId)) throw new Error("Telegram user ID must be numeric");
  if (telegramUserId === ownerTelegramUserId) {
    throw new Error("the owner cannot claim a contributor invitation");
  }
  const claimedAt = nowIso(input.now);

  return db.transaction(() => {
    const invite = db
      .prepare("SELECT * FROM telegram_contributor_invites WHERE token_hash = ?")
      .get(tokenHash(token)) as TelegramContributorInvite | undefined;
    if (!invite) throw new Error("invitation is invalid or expired");

    if (invite.status === "claimed" && invite.claimed_by_telegram_user_id === telegramUserId) {
      const contributor = getActiveTelegramContributor(db, telegramUserId);
      if (contributor) return { contributor, invite, was_existing: true };
    }
    if (invite.status !== "pending" || invite.expires_at <= claimedAt) {
      if (invite.status === "pending") {
        db.prepare("UPDATE telegram_contributor_invites SET status = 'revoked' WHERE id = ?")
          .run(invite.id);
      }
      throw new Error("invitation is invalid or expired");
    }

    const existingIdentity = db
      .prepare("SELECT * FROM telegram_contributors WHERE telegram_user_id = ?")
      .get(telegramUserId) as TelegramContributor | undefined;
    if (existingIdentity?.status === "active") {
      throw new Error("this Telegram account already has contributor access");
    }
    const nameCollision = db
      .prepare(
        `SELECT telegram_user_id FROM telegram_contributors
         WHERE status = 'active' AND counterparty_name = ? COLLATE NOCASE
         LIMIT 1`
      )
      .get(invite.contributor_name) as { telegram_user_id: string } | undefined;
    if (nameCollision && nameCollision.telegram_user_id !== telegramUserId) {
      throw new Error("that contributor name is already linked to another Telegram account");
    }

    if (existingIdentity) {
      db.prepare(
        `UPDATE telegram_contributors SET
          counterparty_name = ?, status = 'active', invite_id = ?,
          activated_at = ?, revoked_at = NULL, updated_at = ?
         WHERE telegram_user_id = ?`
      ).run(invite.contributor_name, invite.id, claimedAt, claimedAt, telegramUserId);
    } else {
      db.prepare(
        `INSERT INTO telegram_contributors (
          telegram_user_id, counterparty_name, status, invite_id,
          activated_at, revoked_at, updated_at
        ) VALUES (?, ?, 'active', ?, ?, NULL, ?)`
      ).run(telegramUserId, invite.contributor_name, invite.id, claimedAt, claimedAt);
    }
    const claimed = db.prepare(
      `UPDATE telegram_contributor_invites SET
        status = 'claimed', claimed_by_telegram_user_id = ?, claimed_at = ?
       WHERE id = ? AND status = 'pending'`
    ).run(telegramUserId, claimedAt, invite.id);
    if (claimed.changes !== 1) throw new Error("invitation was already claimed");

    return {
      contributor: getActiveTelegramContributor(db, telegramUserId) as TelegramContributor,
      invite: db
        .prepare("SELECT * FROM telegram_contributor_invites WHERE id = ?")
        .get(invite.id) as TelegramContributorInvite,
      was_existing: false,
    };
  })();
}

export function listTelegramContributors(
  db: Database.Database,
  input: { include_revoked?: boolean } = {}
): Array<{
  contributor_name: string;
  status: TelegramContributorStatus;
  activated_at: string;
  revoked_at: string | null;
}> {
  const rows = db
    .prepare(
      `SELECT counterparty_name, status, activated_at, revoked_at
       FROM telegram_contributors
       ${input.include_revoked ? "" : "WHERE status = 'active'"}
       ORDER BY counterparty_name COLLATE NOCASE, activated_at`
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
    db.prepare("SELECT COUNT(*) AS count FROM telegram_contributors WHERE status = 'active'")
      .get() as { count: number }
  ).count;
}

export function revokeTelegramContributor(
  db: Database.Database,
  input: { contributor_name: string; now?: Date }
): { contributor_name: string; status: "revoked"; revoked_at: string } {
  const contributorName = normalizedName(input.contributor_name);
  if (!contributorName) throw new Error("contributor_name is required");
  const matches = db
    .prepare(
      `SELECT * FROM telegram_contributors
       WHERE status = 'active' AND counterparty_name = ? COLLATE NOCASE`
    )
    .all(contributorName) as TelegramContributor[];
  if (matches.length === 0) throw new Error(`no active contributor named ${contributorName}`);
  if (matches.length > 1) throw new Error(`multiple active contributors are named ${contributorName}`);
  const revokedAt = nowIso(input.now);
  db.prepare(
    `UPDATE telegram_contributors SET status = 'revoked', revoked_at = ?, updated_at = ?
     WHERE telegram_user_id = ?`
  ).run(revokedAt, revokedAt, matches[0].telegram_user_id);
  return { contributor_name: matches[0].counterparty_name, status: "revoked", revoked_at: revokedAt };
}
