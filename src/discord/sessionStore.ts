// Re-exports from the canonical sessions/ module.
// This file kept for backward compatibility — import directly from src/sessions/ in new code.
export {
	getSession,
	upsertSession,
	incrementMessageCount,
	setGoal,
	setStatus,
	clearSessionOverrides,
} from '../sessions/sessionStore';

export { addMessage, getHistory, clearHistory, countMessages, getLastUserMessage } from '../sessions/conversationStore';

export { getProject, upsertProject, getProjectByCategory } from '../projects/projectSettings';
