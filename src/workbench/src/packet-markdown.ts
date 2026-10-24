import type { packetJson } from "./packet-json.ts";

type PacketExport = ReturnType<typeof packetJson>;
type YamlValue =
  | string | number | boolean | null
  | YamlValue[]
  | { [key: string]: YamlValue };

function yaml(value: YamlValue, depth = 0): string[] {
  const indent = "  ".repeat(depth);
  if (Array.isArray(value))
    return value.flatMap((item) =>
      item !== null && typeof item === "object"
        ? [`${indent}-`, ...yaml(item, depth + 1)]
        : [`${indent}- ${JSON.stringify(item)}`],
    );
  if (value !== null && typeof value === "object")
    return Object.entries(value).flatMap(([key, item]) => {
      const prefix = `${indent}${JSON.stringify(key)}:`;
      if (Array.isArray(item) && !item.length) return [`${prefix} []`];
      if (item !== null && typeof item === "object" && !Object.keys(item).length)
        return [`${prefix} {}`];
      if (item !== null && typeof item === "object")
        return [`${prefix}`, ...yaml(item, depth + 1)];
      return [`${prefix} ${JSON.stringify(item)}`];
    });
  return [`${indent}${JSON.stringify(value)}`];
}

function group(field: string, category: string): string {
  if (category === "claim_summary") {
    const groups: Record<string, string> = {
      routing: "claim", customer: "customer", insuredvehicle: "insured_vehicle",
      rentalvehicle: "rental_vehicle", policy: "policy", rental: "rental",
      repair: "repair", damage: "damage_and_incident", authorization: "authorization",
      priorrentalusage: "rental",
    };
    return groups[field.toLowerCase()] ?? "claim";
  }
  if (category === "tax_1099a") return "supplemental_tax";
  if (/vehicle|vin|odometer|registration|mileage|vehicleclass/i.test(field))
    return "vehicles";
  if (/damage|injur|incident|accident|drivable|repairStatus/i.test(field))
    return "damage_and_incident";
  if (/policy|coverage|deductible|endorsement/i.test(field))
    return "policy";
  if (/customer|firstname|lastname|birthdate|^address$|^sex$|^personalnumber$/i.test(field))
    return "customer";
  if (category === "rental_invoice") return "rental";
  if (category === "repair_estimate") return "repair";
  if (category === "towing_invoice") return "towing";
  return "other_extracted_details";
}

function populated(value: YamlValue): YamlValue | undefined {
  if (value === null || value === "") return undefined;
  if (Array.isArray(value)) {
    const items = value.map(populated).filter((item) => item !== undefined);
    return items.length ? items : undefined;
  }
  if (typeof value === "object") {
    const fields: Record<string, YamlValue> = {};
    for (const [key, child] of Object.entries(value)) {
      const result = populated(child);
      if (result !== undefined) fields[key] = result;
    }
    return Object.keys(fields).length ? fields : undefined;
  }
  return value;
}

function label(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ");
}

function inline(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/[\\`*_{}[\]<>|#!]/g, "\\$&");
}

function fieldLines(fields: Record<string, YamlValue>, depth = 0): string[] {
  const lines: string[] = [];
  const indent = "  ".repeat(depth);
  for (const [key, value] of Object.entries(fields)) {
    const name = inline(label(key));
    if (Array.isArray(value)) {
      lines.push(`${indent}- **${name}:**`);
      for (const [index, item] of value.entries()) {
        if (item !== null && typeof item === "object") {
          lines.push(`${indent}  - Item ${index + 1}`);
          lines.push(...fieldLines(
            Array.isArray(item) ? { values: item } : item,
            depth + 2,
          ));
        } else lines.push(`${indent}  - ${inline(String(item))}`);
      }
    } else if (value !== null && typeof value === "object") {
      lines.push(`${indent}- **${name}:**`, ...fieldLines(value, depth + 1));
    } else {
      lines.push(`${indent}- **${name}:** ${inline(String(value))}`);
    }
  }
  return lines;
}

/** Group only extracted fields; never infer claim facts from labels or examples. */
export function packetMarkdown(packet: PacketExport): string {
  const groups: Record<string, Record<string, YamlValue>[]> = {};
  for (const document of packet.documents) {
    for (const extraction of document.extractions) {
      const fieldsByGroup: Record<string, Record<string, YamlValue>> = {};
      for (const [name, value] of Object.entries(extraction.fields)) {
        const result = populated(value);
        if (result === undefined) continue;
        const nameGroup = group(name, document.category);
        (fieldsByGroup[nameGroup] ??= {})[name] = result;
      }
      for (const [name, fields] of Object.entries(fieldsByGroup)) {
        (groups[name] ??= []).push(fields);
      }
    }
  }
  const ordered: Record<string, YamlValue> = {};
  for (const name of [
    "claim", "customer", "insured_vehicle", "rental_vehicle", "vehicles",
    "damage_and_incident", "policy", "rental", "repair", "authorization",
    "towing", "supplemental_tax", "other_extracted_details",
  ]) {
    if (groups[name]) ordered[name] = groups[name];
  }
  const header: YamlValue = {
    title: `Claim packet ${packet.packet_id}`,
    packet_id: packet.packet_id,
    groups: ordered,
  };
  const sections = [
    "---", ...yaml(header), "---", "",
    `# Claim packet ${packet.packet_id}`, "",
  ];
  for (const name of Object.keys(ordered)) {
    sections.push(`## ${label(name).replace(/^./, (letter) => letter.toUpperCase())}`, "");
    for (const [index, fields] of groups[name].entries()) {
      if (groups[name].length > 1) sections.push(`### Entry ${index + 1}`, "");
      sections.push(...fieldLines(fields), "");
    }
  }
  return sections.join("\n");
}
