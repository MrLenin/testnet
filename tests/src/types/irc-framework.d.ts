/**
 * Type declarations for irc-framework
 *
 * This is a minimal declaration to silence TypeScript errors.
 * The actual irc-framework module is used internally but we primarily
 * use our own RawSocketClient for testing.
 */
declare module 'irc-framework' {
  export interface ClientOptions {
    nick?: string;
    username?: string;
    gecos?: string;
    host?: string;
    port?: number;
    tls?: boolean;
    rejectUnauthorized?: boolean;
    password?: string;
    encoding?: string;
    version?: string;
    auto_reconnect?: boolean;
    auto_reconnect_wait?: number;
    auto_reconnect_max_retries?: number;
    ping_interval?: number;
    ping_timeout?: number;
    enable_cap?: boolean;
  }

  export interface Message {
    prefix: string;
    nick: string;
    ident: string;
    hostname: string;
    command: string;
    params: string[];
    tags: Record<string, string>;
  }

  export interface Channel {
    name: string;
    users: User[];
    join(): void;
    part(message?: string): void;
    say(message: string): void;
  }

  export interface User {
    nick: string;
    ident: string;
    hostname: string;
    modes: string[];
  }

  export class Client {
    constructor(options?: ClientOptions);

    connect(options?: ClientOptions): void;
    quit(message?: string): void;
    raw(line: string): void;
    say(target: string, message: string): void;
    join(channel: string, key?: string): void;
    part(channel: string, message?: string): void;
    whois(nick: string): void;
    nick(newNick: string): void;

    on(event: string, callback: (...args: any[]) => void): void;
    once(event: string, callback: (...args: any[]) => void): void;
    off(event: string, callback: (...args: any[]) => void): void;
    removeListener(event: string, callback: (...args: any[]) => void): void;
    emit(event: string, ...args: any[]): void;
    notice(target: string, message: string): void;
    changeNick(newNick: string): void;

    network: {
      name: string;
      nick: string;
      options: Record<string, any>;
    };

    user: {
      nick: string;
      username: string;
      gecos: string;
    };
  }

  export default Client;
}
