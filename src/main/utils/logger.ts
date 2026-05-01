import chalk from 'chalk'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface LogOptions {
  category?: string
  skipTimestamp?: boolean
}

const CATEGORY_COLORS: Record<string, chalk.Chalk> = {
  ADF: chalk.cyan,
  Mesh: chalk.magenta,
  MessageBus: chalk.blue,
  BackgroundAgent: chalk.yellow,
  TokenUsage: chalk.gray,
  Provider: chalk.green,
  Tool: chalk.blueBright
}

const LEVEL_CONFIG = {
  debug: { prefix: '●', color: chalk.gray },
  info: { prefix: '●', color: chalk.blue },
  warn: { prefix: '⚠', color: chalk.yellow },
  error: { prefix: '✕', color: chalk.red }
}

class Logger {
  private minLevel: LogLevel = 'info'

  setLevel(level: LogLevel) {
    this.minLevel = level
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error']
    return levels.indexOf(level) >= levels.indexOf(this.minLevel)
  }

  private formatMessage(
    level: LogLevel,
    message: string,
    options: LogOptions = {}
  ): string {
    const config = LEVEL_CONFIG[level]
    const timestamp = options.skipTimestamp ? '' : chalk.gray(`[${new Date().toLocaleTimeString()}]`)

    let category = ''
    if (options.category) {
      const categoryColor = CATEGORY_COLORS[options.category] || chalk.white
      category = categoryColor(`[${options.category.padEnd(14)}]`)
    }

    return `${timestamp} ${config.color(config.prefix)} ${category} ${message}`
  }

  debug(message: string, options?: LogOptions) {
    if (this.shouldLog('debug')) {
      console.log(this.formatMessage('debug', message, options))
    }
  }

  info(message: string, options?: LogOptions) {
    if (this.shouldLog('info')) {
      console.log(this.formatMessage('info', message, options))
    }
  }

  warn(message: string, options?: LogOptions) {
    if (this.shouldLog('warn')) {
      console.warn(this.formatMessage('warn', message, options))
    }
  }

  error(message: string, options?: LogOptions) {
    if (this.shouldLog('error')) {
      console.error(this.formatMessage('error', message, options))
    }
  }
}

export const logger = new Logger()

// Set default level based on environment
if (process.env.NODE_ENV === 'production') {
  logger.setLevel('warn')
} else {
  logger.setLevel('info')
}
