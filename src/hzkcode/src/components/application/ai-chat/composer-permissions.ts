import Gauge from "lucide-react/dist/esm/icons/gauge";
import Lock from "lucide-react/dist/esm/icons/lock";
import LockKeyhole from "lucide-react/dist/esm/icons/lock-keyhole";
import CircleHelp from "lucide-react/dist/esm/icons/circle-help";
import PencilLine from "lucide-react/dist/esm/icons/pencil-line";
import Route from "lucide-react/dist/esm/icons/route";
import Shield from "lucide-react/dist/esm/icons/shield";
import ShieldOff from "lucide-react/dist/esm/icons/shield-off";
import type { ComposerPermissionOption } from "./permission-menu";

/** The CLI's permission modes in its Shift+Tab cycle order; Auto Continue is
 *  the CLI default and the composer's starting mode. Ids are the CLI's
 *  machine values ("bypass" is this client's shorthand for the
 *  skip-permissions launch flag). */
export const COMPOSER_PERMISSIONS: ComposerPermissionOption[] = [
  {
    id: "default",
    labelKey: "permissionDefault",
    descriptionKey: "permissionDefaultDesc",
    icon: Shield,
  },
  {
    id: "acceptEdits",
    labelKey: "permissionAcceptEdits",
    descriptionKey: "permissionAcceptEditsDesc",
    icon: PencilLine,
  },
  {
    id: "plan",
    labelKey: "permissionPlan",
    descriptionKey: "permissionPlanDesc",
    icon: Route,
    flip: true,
  },
  {
    id: "readonly",
    labelKey: "permissionReadonly",
    descriptionKey: "permissionReadonlyDesc",
    icon: Lock,
  },
  {
    id: "readonlyAsk",
    labelKey: "permissionReadonlyAsk",
    descriptionKey: "permissionReadonlyAskDesc",
    icon: LockKeyhole,
  },
  {
    id: "auto",
    labelKey: "permissionAutoAsk",
    descriptionKey: "permissionAutoAskDesc",
    icon: CircleHelp,
  },
  {
    id: "autoContinue",
    labelKey: "permissionAutoContinue",
    descriptionKey: "permissionAutoContinueDesc",
    icon: Gauge,
  },
  {
    id: "bypass",
    labelKey: "permissionBypass",
    descriptionKey: "permissionBypassDesc",
    icon: ShieldOff,
  },
];
