export const LICENSE_FILES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"];

export const LICENSE_IDS = [
  "MIT",
  "Apache-2.0",
  "GPL-2.0",
  "GPL-3.0",
  "LGPL-2.1",
  "LGPL-3.0",
  "AGPL-3.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "MPL-2.0",
  "ISC",
  "Unlicense",
  "CC0-1.0",
] as const;

export type LicenseId = (typeof LICENSE_IDS)[number];

/** More specific licenses come first so a shorter text cannot steal the match. */
const CHECKS: { id: LicenseId; phrases: string[] }[] = [
  { id: "AGPL-3.0", phrases: ["gnu affero general public license"] },
  { id: "LGPL-3.0", phrases: ["gnu lesser general public license", "version 3"] },
  { id: "LGPL-2.1", phrases: ["gnu lesser general public license", "version 2.1"] },
  { id: "GPL-3.0", phrases: ["gnu general public license", "version 3"] },
  { id: "GPL-2.0", phrases: ["gnu general public license", "version 2"] },
  { id: "Apache-2.0", phrases: ["apache license", "version 2.0"] },
  { id: "MPL-2.0", phrases: ["mozilla public license", "version 2.0"] },
  { id: "CC0-1.0", phrases: ["cc0 1.0 universal"] },
  { id: "Unlicense", phrases: ["this is free and unencumbered software released into the public domain"] },
  { id: "ISC", phrases: ["permission to use, copy, modify, and/or distribute this software for any purpose with or without fee"] },
  { id: "BSD-3-Clause", phrases: ["redistribution and use in source and binary forms", "neither the name"] },
  { id: "BSD-2-Clause", phrases: ["redistribution and use in source and binary forms", "this software is provided by the copyright holders and contributors"] },
  { id: "MIT", phrases: ["permission is hereby granted, free of charge"] },
];

export function detectLicense(text: string): LicenseId | null {
  const normalized = text.toLowerCase().replace(/\s+/g, " ");
  for (const check of CHECKS) {
    if (check.phrases.every((phrase) => normalized.includes(phrase))) return check.id;
  }
  return null;
}

export function licenseFilename(names: string[]): string | null {
  const wanted = new Map(LICENSE_FILES.map((name) => [name.toLowerCase(), name]));
  for (const name of names) {
    const hit = wanted.get(name.toLowerCase());
    if (hit) return name;
  }
  return null;
}
