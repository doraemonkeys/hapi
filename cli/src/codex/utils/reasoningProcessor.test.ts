import { describe, expect, it, vi } from 'vitest';
import { ReasoningProcessor, type ReasoningOutput } from './reasoningProcessor';

describe('ReasoningProcessor', () => {
    it('attaches thread_id to reasoning message output when complete() receives thread id', () => {
        const onMessage = vi.fn<(message: ReasoningOutput) => void>();
        const processor = new ReasoningProcessor(onMessage);

        processor.complete('Plain reasoning text', 'thread-1');

        expect(onMessage).toHaveBeenCalledTimes(1);
        expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'reasoning',
            message: 'Plain reasoning text',
            thread_id: 'thread-1'
        }));
    });

    it('attaches thread_id to tool-call and tool-call-result for titled reasoning', () => {
        const onMessage = vi.fn<(message: ReasoningOutput) => void>();
        const processor = new ReasoningProcessor(onMessage);

        processor.complete('**Plan** Execute this', 'thread-2');

        expect(onMessage).toHaveBeenCalledTimes(2);
        expect(onMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
            type: 'tool-call',
            name: 'CodexReasoning',
            thread_id: 'thread-2'
        }));
        expect(onMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
            type: 'tool-call-result',
            thread_id: 'thread-2',
            output: expect.objectContaining({
                content: 'Execute this',
                status: 'completed'
            })
        }));
    });

    it('omits thread_id when complete() is called without thread id', () => {
        const onMessage = vi.fn<(message: ReasoningOutput) => void>();
        const processor = new ReasoningProcessor(onMessage);

        processor.complete('No thread metadata');

        const firstCall = onMessage.mock.calls[0]?.[0];
        expect(firstCall).toBeDefined();
        expect(firstCall).not.toHaveProperty('thread_id');
    });

    it('keeps delta thread_id for titled reasoning when complete() omits thread id', () => {
        const onMessage = vi.fn<(message: ReasoningOutput) => void>();
        const processor = new ReasoningProcessor(onMessage);

        processor.processDelta('**Plan** body', 'thread-3');
        processor.processDelta('', 'thread-3');
        processor.complete('**Plan** body');

        expect(onMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
            type: 'tool-call',
            thread_id: 'thread-3'
        }));
        expect(onMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
            type: 'tool-call-result',
            thread_id: 'thread-3'
        }));
    });
});
