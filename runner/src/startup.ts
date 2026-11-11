import os from 'node:os'

// A plugin host can outlive the directory its updater removed.
try { process.cwd() } catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  process.chdir(os.homedir())
}
