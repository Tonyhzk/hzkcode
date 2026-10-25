import Gauge from "lucide-react/dist/esm/icons/gauge";
import Lock from "lucide-react/dist/esm/icons/lock";
import CircleHelp from "lucide-react/dist/esm/icons/circle-help";
import PencilLine from "lucide-react/dist/esm/icons/pencil-line";
import Route from "lucide-react/dist/esm/icons/route";
import Shield from "lucide-react/dist/esm/icons/shield";
import ShieldOff from "lucide-react/dist/esm/icons/shield-off";
import type { LucideIcon } from "lucide-react";
import type {
  PermissionBoundary,
  PermissionSwitchKey,
} from "./permission-modes";

export interface PermissionBoundaryOption {
  id: PermissionBoundary;
  /** i18n keys under `chat.` for label and description. */
  labelKey: string;
  descriptionKey: string;
  icon: LucideIcon;
  /** Figma draws the route glyph mirrored on the vertical axis. */
  flip?: boolean;
}

export interface PermissionSwitchOption {
  id: PermissionSwitchKey;
  labelKey: string;
  descriptionKey: string;
  icon: LucideIcon;
}

export interface LegacyPermissionOption {
  id: "plan";
  labelKey: string;
  descriptionKey: string;
  icon: LucideIcon;
  flip?: boolean;
}

/** 边界按 CLI 循环顺序排列；bypass 单独一行且没有开关。 */
export const PERMISSION_BOUNDARY_OPTIONS: PermissionBoundaryOption[] = [
  {
    id: "default",
    labelKey: "permissionBoundaryDefault",
    descriptionKey: "permissionBoundaryDefaultDesc",
    icon: Shield,
  },
  {
    id: "readonly",
    labelKey: "permissionBoundaryReadonly",
    descriptionKey: "permissionBoundaryReadonlyDesc",
    icon: Lock,
  },
  {
    id: "plan",
    labelKey: "permissionBoundaryPlan",
    descriptionKey: "permissionBoundaryPlanDesc",
    icon: Route,
    flip: true,
  },
  {
    id: "bypass",
    labelKey: "permissionBypass",
    descriptionKey: "permissionBypassDesc",
    icon: ShieldOff,
  },
];

/** 三个开关；自动接受修改只在默认边界可用。 */
export const PERMISSION_SWITCH_OPTIONS: PermissionSwitchOption[] = [
  {
    id: "autoReview",
    labelKey: "permissionSwitchAutoReview",
    descriptionKey: "permissionSwitchAutoReviewDesc",
    icon: CircleHelp,
  },
  {
    id: "autoContinue",
    labelKey: "permissionSwitchAutoContinue",
    descriptionKey: "permissionSwitchAutoContinueDesc",
    icon: Gauge,
  },
  {
    id: "acceptEdits",
    labelKey: "permissionSwitchAcceptEdits",
    descriptionKey: "permissionSwitchAcceptEditsDesc",
    icon: PencilLine,
  },
];

/** 旧 `plan` 不属于新视图的边界：单独列出，保留既有偏好的旧语义，
 *  不擅自放宽。 */
export const LEGACY_PLAN_OPTION: LegacyPermissionOption = {
  id: "plan",
  labelKey: "permissionLegacyPlan",
  descriptionKey: "permissionLegacyPlanDesc",
  icon: Route,
  flip: true,
};
