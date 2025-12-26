import type { Reporter, Vitest, TaskResultPack, File, Task } from 'vitest';

/**
 * Custom Vitest reporter that shows what each test is trying to prove
 * Output is more human-readable with clear pass/fail status
 */
export default class ReadableReporter implements Reporter {
  ctx!: Vitest;
  startTime: number = 0;
  passCount = 0;
  failCount = 0;
  skipCount = 0;

  onInit(ctx: Vitest) {
    this.ctx = ctx;
    this.startTime = Date.now();
    console.log('\n' + '='.repeat(70));
    console.log('  IRC Integration Test Suite');
    console.log('='.repeat(70) + '\n');
  }

  onCollected(files?: File[]) {
    if (!files) return;
    const testCount = files.reduce((acc, file) => {
      return acc + this.countTests(file.tasks);
    }, 0);
    console.log(`Collected ${testCount} tests from ${files.length} file(s)\n`);
  }

  private countTests(tasks: Task[]): number {
    let count = 0;
    for (const task of tasks) {
      if (task.type === 'test') {
        count++;
      } else if (task.type === 'suite' && task.tasks) {
        count += this.countTests(task.tasks);
      }
    }
    return count;
  }

  onTaskUpdate(packs: TaskResultPack[]) {
    for (const pack of packs) {
      const [taskId, result] = pack;
      const task = this.ctx.state.idMap.get(taskId);
      if (!task || task.type !== 'test') continue;

      // Get the suite chain for context
      const suitePath = this.getSuitePath(task);
      const indent = '  '.repeat(Math.min(suitePath.length, 2));

      if (result?.state === 'pass') {
        this.passCount++;
        console.log(`${indent}\x1b[32m\u2713\x1b[0m ${task.name}`);
        // Show what this test proves
        const purpose = this.getTestPurpose(task.name);
        if (purpose) {
          console.log(`${indent}  \x1b[90m\u2192 Proves: ${purpose}\x1b[0m`);
        }
      } else if (result?.state === 'fail') {
        this.failCount++;
        console.log(`${indent}\x1b[31m\u2717\x1b[0m ${task.name}`);
        if (result.errors) {
          for (const error of result.errors) {
            const msg = error.message?.split('\n')[0] || 'Unknown error';
            console.log(`${indent}  \x1b[31m\u2514\u2500 ${msg}\x1b[0m`);
          }
        }
      } else if (result?.state === 'skip') {
        this.skipCount++;
        console.log(`${indent}\x1b[33m\u25CB\x1b[0m ${task.name} \x1b[90m(skipped)\x1b[0m`);
      }
    }
  }

  private getSuitePath(task: Task): string[] {
    const path: string[] = [];
    let current: Task | undefined = task;
    while (current?.suite) {
      if (current.suite.name) {
        path.unshift(current.suite.name);
      }
      current = current.suite as Task;
    }
    return path;
  }

  /**
   * Extract the purpose/proof from the test name.
   * This maps test names to what they're proving about the system.
   */
  private getTestPurpose(testName: string): string | null {
    const lowerName = testName.toLowerCase();

    // CAP negotiation tests
    if (lowerName.includes('cap ls')) {
      return 'Server advertises capabilities per IRCv3 CAP specification';
    }
    if (lowerName.includes('cap req')) {
      return 'Server correctly handles capability requests';
    }
    if (lowerName.includes('cap ack')) {
      return 'Server acknowledges requested capabilities';
    }
    if (lowerName.includes('cap nak')) {
      return 'Server rejects unsupported capability requests';
    }

    // SASL tests
    if (lowerName.includes('sasl plain')) {
      return 'SASL PLAIN authentication works with valid credentials';
    }
    if (lowerName.includes('sasl') && lowerName.includes('fail')) {
      return 'Server rejects invalid SASL credentials';
    }

    // Account registration
    if (lowerName.includes('register')) {
      return 'IRCv3 account-registration extension works';
    }

    // Metadata tests
    if (lowerName.includes('metadata')) {
      return 'IRCv3 draft/metadata-2 extension is functional';
    }

    // Read marker tests
    if (lowerName.includes('read-marker') || lowerName.includes('markread')) {
      return 'IRCv3 draft/read-marker extension tracks read positions';
    }

    // Webpush tests
    if (lowerName.includes('webpush') || lowerName.includes('vapid')) {
      return 'Web push notification subscriptions work';
    }

    // Channel rename tests
    if (lowerName.includes('rename')) {
      return 'Channel renaming works per draft/channel-rename spec';
    }

    // Redaction tests
    if (lowerName.includes('redact')) {
      return 'Message redaction works per draft/message-redaction spec';
    }

    // Standard replies tests
    if (lowerName.includes('standard-replies') || lowerName.includes('fail ') || lowerName.includes('warn ') || lowerName.includes('note ')) {
      return 'Server uses IRCv3 standard-replies format';
    }

    // Chathistory tests
    if (lowerName.includes('chathistory') || lowerName.includes('history')) {
      return 'Message history retrieval works';
    }

    // Pre-away tests
    if (lowerName.includes('pre-away')) {
      return 'Pre-away status is restored on reconnect';
    }

    // Multi-server tests
    if (lowerName.includes('cross-server') || lowerName.includes('multi-server')) {
      return 'Feature works correctly across linked servers';
    }
    if (lowerName.includes('server link') || lowerName.includes('servers are linked')) {
      return 'IRC servers are properly linked via P10 protocol';
    }
    if (lowerName.includes('remote server')) {
      return 'Commands work for users on remote servers';
    }

    return null;
  }

  onFinished(files?: File[], errors?: unknown[]) {
    const duration = ((Date.now() - this.startTime) / 1000).toFixed(2);

    console.log('\n' + '-'.repeat(70));
    console.log('  Test Summary');
    console.log('-'.repeat(70));

    if (this.passCount > 0) {
      console.log(`  \x1b[32m\u2713 ${this.passCount} passed\x1b[0m`);
    }
    if (this.failCount > 0) {
      console.log(`  \x1b[31m\u2717 ${this.failCount} failed\x1b[0m`);
    }
    if (this.skipCount > 0) {
      console.log(`  \x1b[33m\u25CB ${this.skipCount} skipped\x1b[0m`);
    }

    console.log(`  \u23F1  ${duration}s`);
    console.log('='.repeat(70) + '\n');

    if (errors && errors.length > 0) {
      console.log('\x1b[31mErrors during test run:\x1b[0m');
      for (const error of errors) {
        console.log(error);
      }
    }
  }
}
