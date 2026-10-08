import { collect, type SecretRequest } from './secret_prompt.js';
import { Sandbox } from './sandbox.js';
import { isRecord } from './settings.js';
export interface QuestionOption {
  label: string;
  description: string;
}
export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple: boolean;
  custom: boolean;
}
export interface QuestionHooks {
  ask?: (
    args: { questions: Question[] },
    signal: AbortSignal,
  ) => Promise<string>;
  secret?: (request: SecretRequest, signal: AbortSignal) => Promise<void>;
}
export function panelQuestion(value: Record<string, unknown>): Question {
  const raw = value.options ?? value.choices ?? [];
  const options: QuestionOption[] = [];
  if (Array.isArray(raw))
    for (const option of raw) {
      const label = isRecord(option)
        ? String(option.label || option.text || '').trim()
        : String(option).trim();
      if (label)
        options.push({
          label,
          description: isRecord(option) ? String(option.description || '') : '',
        });
    }
  return {
    question:
      String(value.question || value.prompt || '').trim() || '(empty question)',
    header: String(value.header || '').trim(),
    options,
    multiple: Boolean(value.multiple || value.multiSelect),
    custom: value.custom !== false || !options.length,
  };
}
export async function askQuestions(
  home: string,
  sandbox: Sandbox,
  raw: Record<string, unknown>,
  signal: AbortSignal,
  hooks: QuestionHooks = {},
  timeoutMs = 600000,
): Promise<string> {
  if (
    !Array.isArray(raw.questions) ||
    !raw.questions.length ||
    !raw.questions.every(isRecord)
  )
    throw new Error('questions list must contain objects');
  const plain = raw.questions.filter((question) => !question.secret);
  const secret = raw.questions.filter((question) => question.secret);
  const lines: string[] = [];
  if (plain.length) {
    const questions = plain.map(panelQuestion);
    if (hooks.ask) {
      const reply = await hooks.ask({ questions }, signal);
      signal.throwIfAborted();
      let decoded: unknown;
      try {
        decoded = JSON.parse(reply);
      } catch {
        decoded = undefined;
      }
      const values = Array.isArray(decoded)
        ? decoded
        : isRecord(decoded) && Array.isArray(decoded.answers)
          ? decoded.answers
          : undefined;
      if (!values)
        lines.push(
          'The user closed the question panel without answering. Do not assume an answer: ask again in chat if needed.',
        );
      else
        lines.push(
          'The user answered in the question panel (an empty answer means the user left it unanswered):\n' +
            JSON.stringify(
              questions.map((question, index) => ({
                question: question.question,
                answer: Array.isArray(values[index])
                  ? values[index].map(String)
                  : typeof values[index] === 'string'
                    ? [values[index]]
                    : [],
              })),
              null,
              2,
            ),
        );
    } else
      lines.push(
        'USER_QUESTIONS — present these to the user and wait for answers before continuing irreversible work:\n\n' +
          questions
            .map(
              (question, index) =>
                `${index + 1}. ${question.question}\n${question.options.map((option) => '   - ' + option.label).join('\n')}${question.multiple ? '\n   (multiple selections allowed)' : ''}`,
            )
            .join('\n\n') +
          '\n\nAfter the user answers in chat, continue with their choices. Do not invent answers.',
      );
  }
  if (secret.length) {
    const requests = secret.map((question) => {
      if (
        typeof question.target_file !== 'string' ||
        !question.target_file.trim()
      )
        throw new Error('secret question names no target_file');
      return {
        question: String(question.question || '').trim(),
        key: String(question.key || '').trim(),
        target_file: sandbox.resolvePath(
          String(question.target_file || '').trim(),
        ),
      };
    });
    try {
      const confirmations = await collect(
        home,
        requests,
        signal,
        hooks.secret,
        timeoutMs,
      );
      lines.push(
        'SECRET_QUESTIONS — collected via masked input, values never entered this conversation:\n' +
          confirmations.join('\n'),
      );
    } catch (error) {
      signal.throwIfAborted();
      lines.push(
        'SECRET_QUESTIONS — the secret was not collected. Ask the user to enter the credential in the target file themselves, never in chat.',
      );
    }
  }
  return lines.join('\n\n');
}
export const QUESTION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          prompt: { type: 'string' },
          header: { type: 'string' },
          options: {
            type: 'array',
            items: {
              anyOf: [
                { type: 'string' },
                {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    text: { type: 'string' },
                    description: { type: 'string' },
                  },
                },
              ],
            },
          },
          choices: { type: 'array' },
          multiple: { type: 'boolean' },
          multiSelect: { type: 'boolean' },
          custom: { type: 'boolean' },
          secret: { type: 'boolean' },
          key: { type: 'string' },
          target_file: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
  },
  required: ['questions'],
  additionalProperties: false,
};
