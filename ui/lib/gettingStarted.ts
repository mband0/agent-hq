import type { AtlasWidgetCommand } from './atlasWidget';

export type GettingStartedStatus = 'not_started' | 'active' | 'dismissed' | 'completed';

export interface GettingStartedStep {
  id: string;
  route: string;
  selector: string;
  title: string;
  description: string;
  continueLabel?: string;
  enterCommand?: AtlasWidgetCommand;
  preferredCardSide?: 'left' | 'right';
}

export interface GettingStartedSnapshot {
  status: GettingStartedStatus;
  stepIndex: number;
}

const STATUS_KEY = 'agent-hq:getting-started:status';
const STEP_KEY = 'agent-hq:getting-started:step';

export const GETTING_STARTED_CHANGED_EVENT = 'agent-hq:getting-started:changed';

export const GETTING_STARTED_STEPS: GettingStartedStep[] = [
  {
    id: 'atlas-bubble',
    route: '/',
    selector: '[data-tour-target="atlas-chat-bubble"]',
    title: 'This Atlas bubble is your fastest way to get help',
    description: 'Any time you are unsure what to do, click here. Atlas can guide you, answer questions, and help you configure Agent HQ in plain English.',
  },
  {
    id: 'dashboard',
    route: '/',
    selector: '[data-tour-target="dashboard-overview"]',
    title: 'This is your dashboard',
    description: 'Use the dashboard as your control center. It shows what is active, what finished recently, and where to jump next.',
  },
  {
    id: 'tasks',
    route: '/tasks',
    selector: '[data-tour-target="tasks-board"]',
    title: 'Tasks are the core unit of work',
    description: 'Everything your team plans or executes lives here. Create tasks, track status, and see work move across the board.',
  },
  {
    id: 'projects',
    route: '/projects',
    selector: '[data-tour-target="projects-list"]',
    title: 'Projects group related work',
    description: 'Projects keep tasks, sprints, and agents organized around one body of work so your workspace stays structured.',
  },
  {
    id: 'sprints',
    route: '/sprints',
    selector: '[data-tour-target="sprints-list"]',
    title: 'Sprints organize what is happening now',
    description: 'Use sprints to focus a batch of work, track progress, and separate active work from backlog work.',
  },
  {
    id: 'sprint-definitions',
    route: '/sprint-definitions',
    selector: '[data-tour-target="sprint-definitions-main"]',
    title: 'Sprint Definitions shape how work is planned',
    description: 'This is where you define sprint types and task attributes before routing rules decide who handles the work.',
  },
  {
    id: 'agents',
    route: '/agents',
    selector: '[data-tour-target="agents-list"]',
    title: 'Agents are your AI workers',
    description: 'Each agent has a role and runtime. This page shows who is available to execute different kinds of tasks.',
  },
  {
    id: 'routing',
    route: '/routing',
    selector: '[data-tour-target="routing-rules"]',
    title: 'Routing decides which agent gets which task',
    description: 'Task Routing is the rules engine. It maps task type and status to the right agent so work is assigned predictably.',
  },
  {
    id: 'chat',
    route: '/chat',
    selector: '[data-tour-target="chat-main-panel"]',
    title: 'Chat is where you can talk directly to agents',
    description: 'Use Chat to review conversation history, check on work, and give direct instructions outside the task board.',
  },
  {
    id: 'atlas-customize',
    route: '/',
    selector: '[data-tour-target="atlas-widget-composer"]',
    title: 'Now let Atlas help customize your workspace',
    description: 'I opened Atlas with a starter prompt. Edit it with your real workflow, then send it to get help defining sprint types and task routing.',
    continueLabel: 'Finish',
    preferredCardSide: 'left',
    enterCommand: {
      type: 'open-chat-with-draft',
      text: `Help me customize Agent HQ for my workflow.\n\nI want help defining:\n- the sprint types I should use\n- the task types we should route\n- which agent should handle each kind of work\n\nPlease recommend a simple starting setup and explain the reasoning.`,
      focus: true,
    },
  },
];

function emitChange(snapshot: GettingStartedSnapshot) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(GETTING_STARTED_CHANGED_EVENT, { detail: snapshot }));
}

function readStatus(): GettingStartedStatus {
  if (typeof window === 'undefined') return 'not_started';
  const raw = localStorage.getItem(STATUS_KEY);
  if (raw === 'active' || raw === 'dismissed' || raw === 'completed') return raw;
  return 'not_started';
}

function readStepIndex(): number {
  if (typeof window === 'undefined') return 0;
  const raw = Number(localStorage.getItem(STEP_KEY) ?? '0');
  if (!Number.isFinite(raw) || raw < 0) return 0;
  return Math.min(raw, Math.max(0, GETTING_STARTED_STEPS.length - 1));
}

export function getGettingStartedSnapshot(): GettingStartedSnapshot {
  return {
    status: readStatus(),
    stepIndex: readStepIndex(),
  };
}

export function beginGettingStartedGuide(stepIndex = 0) {
  if (typeof window === 'undefined') return;
  const nextIndex = Math.min(Math.max(stepIndex, 0), Math.max(0, GETTING_STARTED_STEPS.length - 1));
  localStorage.setItem(STATUS_KEY, 'active');
  localStorage.setItem(STEP_KEY, String(nextIndex));
  emitChange({ status: 'active', stepIndex: nextIndex });
}

export function setGettingStartedStep(stepIndex: number) {
  if (typeof window === 'undefined') return;
  const nextIndex = Math.min(Math.max(stepIndex, 0), Math.max(0, GETTING_STARTED_STEPS.length - 1));
  localStorage.setItem(STEP_KEY, String(nextIndex));
  emitChange({ status: readStatus(), stepIndex: nextIndex });
}

export function dismissGettingStartedGuide() {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STATUS_KEY, 'dismissed');
  emitChange({ status: 'dismissed', stepIndex: readStepIndex() });
}

export function completeGettingStartedGuide() {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STATUS_KEY, 'completed');
  emitChange({ status: 'completed', stepIndex: GETTING_STARTED_STEPS.length - 1 });
}
