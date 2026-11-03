import type { Role } from "../config.js";
import { beatsmith } from "./beatsmith.js";
import { montage } from "./montage.js";
import { renderfarm } from "./renderfarm.js";
import { sketchboard } from "./sketchboard.js";
import type { RoleSpec } from "./types.js";

const SPECS: Record<Role, RoleSpec<any>> = { montage, renderfarm, beatsmith, sketchboard };

export function roleSpec(role: Role): RoleSpec<any> {
  return SPECS[role];
}
