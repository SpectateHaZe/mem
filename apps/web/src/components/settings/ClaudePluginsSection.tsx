import type { ClaudePluginAction, ClaudePluginsSnapshot, EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsSection } from "./settingsLayout";

const BROWSE_LIMIT = 40;

/** Claude Code plugins, marketplaces and personal skills, managed through the `claude plugin` CLI. */
export function ClaudePluginsSection({
  environmentId,
  readOnly,
}: {
  environmentId: EnvironmentId;
  readOnly: boolean;
}) {
  const read = useAtomCommand(serverEnvironment.readClaudePlugins);
  const run = useAtomCommand(serverEnvironment.runClaudePluginAction);
  const [snapshot, setSnapshot] = useState<ClaudePluginsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [marketplaceSource, setMarketplaceSource] = useState("");
  const [skillFolder, setSkillFolder] = useState("");

  const load = async () => {
    setLoading(true);
    const result = await read({ environmentId, input: {} });
    if (result._tag === "Success") setSnapshot(result.value);
    setLoading(false);
  };

  const act = async (action: ClaudePluginAction, target: string) => {
    const key = `${action}:${target}`;
    setBusy(key);
    const result = await run({ environmentId, input: { action, target } });
    if (result._tag === "Success") setSnapshot(result.value);
    setBusy(null);
    return result._tag === "Success";
  };

  const disabled = readOnly || busy !== null;
  const isBusy = (action: ClaudePluginAction, target: string) => busy === `${action}:${target}`;
  const installedIds = new Set(snapshot?.installed.map((plugin) => plugin.id));
  const needle = query.trim().toLowerCase();
  const matches = (snapshot?.available ?? [])
    .filter((plugin) => !installedIds.has(plugin.pluginId))
    .filter(
      (plugin) =>
        needle === "" ||
        plugin.name.toLowerCase().includes(needle) ||
        (plugin.description ?? "").toLowerCase().includes(needle),
    )
    .toSorted((left, right) => (right.installCount ?? 0) - (left.installCount ?? 0));

  return (
    <SettingsSection
      title="Plugins & skills"
      headerAction={
        snapshot === null ? undefined : (
          <Button size="compact" variant="ghost" onClick={() => void load()} disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-5 px-3 py-3 text-sm sm:px-4">
        {snapshot === null ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Install, enable and remove Claude Code plugins, marketplaces and your own skills.
            </p>
            <Button size="compact" variant="outline" disabled={loading} onClick={() => void load()}>
              {loading ? "Loading…" : "Show plugins"}
            </Button>
          </div>
        ) : null}
        {snapshot?.error ? (
          <p className="text-xs text-destructive-foreground">{snapshot.error}</p>
        ) : null}

        {snapshot && snapshot.installed.length > 0 ? (
          <Group title="Installed plugins">
            {snapshot.installed.map((plugin) => {
              // Plugins synced from claude.ai are managed there; the CLI cannot change them.
              const synced = plugin.scope === "synced";
              return (
                <Row
                  key={plugin.id}
                  title={plugin.id}
                  detail={[plugin.version && `v${plugin.version}`, plugin.scope]
                    .filter(Boolean)
                    .join(" · ")}
                >
                  <Switch
                    aria-label={`${plugin.enabled ? "Disable" : "Enable"} ${plugin.id}`}
                    checked={plugin.enabled}
                    disabled={disabled || synced}
                    onCheckedChange={(on) => void act(on ? "enable" : "disable", plugin.id)}
                  />
                  {synced ? null : (
                    <>
                      <Button
                        size="compact"
                        variant="outline"
                        disabled={disabled}
                        onClick={() => void act("update", plugin.id)}
                      >
                        {isBusy("update", plugin.id) ? "Updating…" : "Update"}
                      </Button>
                      <Button
                        size="compact"
                        variant="destructive-outline"
                        disabled={disabled}
                        onClick={() => void act("uninstall", plugin.id)}
                      >
                        {isBusy("uninstall", plugin.id) ? "Removing…" : "Uninstall"}
                      </Button>
                    </>
                  )}
                </Row>
              );
            })}
          </Group>
        ) : null}

        {snapshot && snapshot.available.length > 0 ? (
          <Group title="Browse plugins">
            <Input
              aria-label="Search plugins"
              placeholder={`Search ${snapshot.available.length.toLocaleString()} plugins`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {matches.slice(0, BROWSE_LIMIT).map((plugin) => (
              <Row
                key={plugin.pluginId}
                title={plugin.name}
                detail={[
                  plugin.marketplaceName,
                  plugin.installCount !== undefined &&
                    `${plugin.installCount.toLocaleString()} installs`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                description={plugin.description}
              >
                <Button
                  size="compact"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => void act("install", plugin.pluginId)}
                >
                  {isBusy("install", plugin.pluginId) ? "Installing…" : "Install"}
                </Button>
              </Row>
            ))}
            {matches.length > BROWSE_LIMIT ? (
              <p className="text-xs text-muted-foreground">
                {(matches.length - BROWSE_LIMIT).toLocaleString()} more. Search to narrow the list.
              </p>
            ) : null}
          </Group>
        ) : null}

        {snapshot && !snapshot.error ? (
          <Group title="Marketplaces">
            {snapshot.marketplaces.map((marketplace) => (
              <Row key={marketplace.name} title={marketplace.name} detail={marketplace.origin}>
                <Button
                  size="compact"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => void act("marketplaceUpdate", marketplace.name)}
                >
                  {isBusy("marketplaceUpdate", marketplace.name) ? "Updating…" : "Update"}
                </Button>
                <Button
                  size="compact"
                  variant="destructive-outline"
                  disabled={disabled}
                  onClick={() => void act("marketplaceRemove", marketplace.name)}
                >
                  Remove
                </Button>
              </Row>
            ))}
            <AddField
              label="Add a marketplace"
              placeholder="owner/repo, a git URL or a folder path"
              value={marketplaceSource}
              onChange={setMarketplaceSource}
              disabled={disabled}
              busy={isBusy("marketplaceAdd", marketplaceSource.trim())}
              onAdd={async () => {
                if (await act("marketplaceAdd", marketplaceSource.trim())) setMarketplaceSource("");
              }}
            />
          </Group>
        ) : null}

        {snapshot ? (
          <Group title="Personal skills">
            <p className="text-xs text-muted-foreground">
              Skills in <span className="font-mono">{snapshot.skillsDirectory}</span>, outside any
              plugin.
            </p>
            {snapshot.skills.map((skill) => (
              <Row key={skill.name} title={skill.name} description={skill.description}>
                <Button
                  size="compact"
                  variant="destructive-outline"
                  disabled={disabled}
                  onClick={() => void act("skillRemove", skill.name)}
                >
                  {isBusy("skillRemove", skill.name) ? "Removing…" : "Remove"}
                </Button>
              </Row>
            ))}
            <AddField
              label="Add a skill"
              placeholder="Path to a folder that contains SKILL.md"
              value={skillFolder}
              onChange={setSkillFolder}
              disabled={disabled}
              busy={isBusy("skillAdd", skillFolder.trim())}
              onAdd={async () => {
                if (await act("skillAdd", skillFolder.trim())) setSkillFolder("");
              }}
            />
          </Group>
        ) : null}

        <p className="text-xs text-muted-foreground">
          Changes apply to new Claude sessions. Plugins that install by running a command must be
          installed from a terminal, where you can review that command first.
        </p>
      </div>
    </SettingsSection>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
      {children}
    </div>
  );
}

function Row({
  title,
  detail,
  description,
  children,
}: {
  title: string;
  detail?: string | undefined;
  description?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border/60 pb-2 last:border-b-0">
      <div className="min-w-0">
        <div className="truncate font-medium">{title}</div>
        {detail ? <div className="truncate text-xs text-muted-foreground">{detail}</div> : null}
        {description ? (
          <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{description}</div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

function AddField({
  label,
  placeholder,
  value,
  onChange,
  disabled,
  busy,
  onAdd,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  busy: boolean;
  onAdd: () => Promise<void>;
}) {
  const ready = value.trim() !== "" && !value.trim().startsWith("-");
  return (
    <div className="flex gap-2">
      <Input
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && ready && !disabled) void onAdd();
        }}
      />
      <Button variant="outline" disabled={disabled || !ready} onClick={() => void onAdd()}>
        {busy ? "Adding…" : "Add"}
      </Button>
    </div>
  );
}
