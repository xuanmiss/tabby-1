import * as path from 'path'
import * as fs from 'fs/promises'
import * as gracefulFS from 'graceful-fs'
import * as fsSync from 'fs'
import * as os from 'os'
import { promisify } from 'util'
import promiseIpc, { RendererProcessType } from 'electron-promise-ipc'
import { execFile } from 'mz/child_process'
import { Injectable, NgZone } from '@angular/core'
import { PlatformService, ClipboardContent, HostAppService, Platform, MenuItemOptions, MessageBoxOptions, MessageBoxResult, FileUpload, FileDownload, FileUploadOptions, wrapPromise } from 'tabby-core'
import { ElectronService } from '../services/electron.service'
import { ElectronHostWindow } from './hostWindow.service'
import { ShellIntegrationService } from './shellIntegration.service'
const fontManager = require('fontmanager-redux') // eslint-disable-line

/* eslint-disable block-scoped-var */

try {
    // eslint-disable-next-line no-var
    var windowsProcessTreeNative = require('windows-process-tree/build/Release/windows_process_tree.node')
    // eslint-disable-next-line no-var
    var wnr = require('windows-native-registry')
} catch { }

@Injectable({ providedIn: 'root' })
export class ElectronPlatformService extends PlatformService {
    supportsWindowControls = true
    private configPath: string
    private _configSaveInProgress = Promise.resolve()

    constructor (
        private hostApp: HostAppService,
        private hostWindow: ElectronHostWindow,
        private electron: ElectronService,
        private zone: NgZone,
        private shellIntegration: ShellIntegrationService,
    ) {
        super()
        this.configPath = path.join(electron.app.getPath('userData'), 'config.yaml')

        electron.ipcRenderer.on('host:display-metrics-changed', () => {
            this.zone.run(() => this.displayMetricsChanged.next())
        })
    }

    readClipboard (): string {
        return this.electron.clipboard.readText()
    }

    setClipboard (content: ClipboardContent): void {
        require('@electron/remote').clipboard.write(content)
    }

    async installPlugin (name: string, version: string): Promise<void> {
        await (promiseIpc as RendererProcessType).send('plugin-manager:install', name, version)
    }

    async uninstallPlugin (name: string): Promise<void> {
        await (promiseIpc as RendererProcessType).send('plugin-manager:uninstall', name)
    }

    async isProcessRunning (name: string): Promise<boolean> {
        if (this.hostApp.platform === Platform.Windows) {
            return new Promise<boolean>(resolve => {
                windowsProcessTreeNative.getProcessList(list => { // eslint-disable-line block-scoped-var
                    resolve(list.some(x => x.name === name))
                }, 0)
            })
        } else {
            throw new Error('Not supported')
        }
    }

    getWinSCPPath (): string|null {
        const key = wnr.getRegistryKey(wnr.HK.CR, 'WinSCP.Url\\DefaultIcon')
        if (key?.['']) {
            let detectedPath = key[''].value?.split(',')[0]
            detectedPath = detectedPath?.substring(1, detectedPath.length - 1)
            return detectedPath
        }
        return null
    }

    exec (app: string, argv: string[]): void {
        execFile(app, argv)
    }

    isShellIntegrationSupported (): boolean {
        return this.hostApp.platform !== Platform.Linux
    }

    async isShellIntegrationInstalled (): Promise<boolean> {
        return this.shellIntegration.isInstalled()
    }

    async installShellIntegration (): Promise<void> {
        await this.shellIntegration.install()
    }

    async uninstallShellIntegration (): Promise<void> {
        await this.shellIntegration.remove()
    }

    async loadConfig (): Promise<string> {
        if (fsSync.existsSync(this.configPath)) {
            return fs.readFile(this.configPath, 'utf8')
        } else {
            return ''
        }
    }

    async saveConfig (content: string): Promise<void> {
        try {
            await this._configSaveInProgress
        } catch { }
        this._configSaveInProgress = this._saveConfigInternal(content)
        await this._configSaveInProgress
    }

    async _saveConfigInternal (content: string): Promise<void> {
        const tempPath = this.configPath + '.new'
        await fs.writeFile(tempPath, content, 'utf8')
        await fs.writeFile(this.configPath + '.backup', content, 'utf8')
        await promisify(gracefulFS.rename)(tempPath, this.configPath)
    }

    getConfigPath (): string|null {
        return this.configPath
    }

    showItemInFolder (p: string): void {
        this.electron.shell.showItemInFolder(p)
    }

    openExternal (url: string): void {
        this.electron.shell.openExternal(url)
    }

    openPath (p: string): void {
        this.electron.shell.openPath(p)
    }

    getOSRelease (): string {
        return os.release()
    }

    getAppVersion (): string {
        return this.electron.app.getVersion()
    }

    async listFonts (): Promise<string[]> {
        if (this.hostApp.platform === Platform.Windows || this.hostApp.platform === Platform.macOS) {
            let fonts = await new Promise<any[]>((resolve) => fontManager.findFonts({ monospace: true }, resolve))
            fonts = fonts.map(x => x.family.trim())
            return fonts
        }
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (this.hostApp.platform === Platform.Linux) {
            const stdout = (await execFile('fc-list', [':spacing=mono']))[0]
            const fonts = stdout.toString()
                .split('\n')
                .filter(x => !!x)
                .map(x => x.split(':')[1].trim())
                .map(x => x.split(',')[0].trim())
            fonts.sort()
            return fonts
        }
        return []
    }

    popupContextMenu (menu: MenuItemOptions[], _event?: MouseEvent): void {
        this.electron.Menu.buildFromTemplate(menu.map(item => this.rewrapMenuItemOptions(item))).popup({})
    }

    rewrapMenuItemOptions (menu: MenuItemOptions): MenuItemOptions {
        return {
            ...menu,
            click: () => {
                this.zone.run(() => {
                    menu.click?.()
                })
            },
            submenu: menu.submenu ? menu.submenu.map(x => this.rewrapMenuItemOptions(x)) : undefined,
        }
    }

    async showMessageBox (options: MessageBoxOptions): Promise<MessageBoxResult> {
        return this.electron.dialog.showMessageBox(this.hostWindow.getWindow(), options)
    }

    quit (): void {
        this.electron.app.exit(0)
    }

    async startUpload (options?: FileUploadOptions, paths?: string[]): Promise<FileUpload[]> {
        options ??= { multiple: false }

        // https://www.electronjs.org/zh/docs/latest/api/dialog 这里有文档
        const properties: any[] = ['openFile', 'openDirectory', 'treatPackageAsDirectory']
        if (options.multiple) {
            properties.push('multiSelections')
        }
        const filePaths: FileDirElement[] = []
        if (!paths) {
            const result = await this.electron.dialog.showOpenDialog(
                this.hostWindow.getWindow(),
                {
                    buttonLabel: 'Select',
                    properties,
                },
            )
            if (result.canceled) {
                return []
            }
            paths = result.filePaths
            for (const p of paths) {
                // const p = paths[i]
                const stats = fsSync.statSync(p)
                const isFile = stats.isFile() // 是否为文件
                const isDir = stats.isDirectory() // 是否为文件夹
                if (isFile) {
                    const fileDirElement = new FileDirElement(p, '')
                    filePaths.push(fileDirElement)
                }
                if (isDir) {
                    this.fileDisplay(filePaths, p, path.dirname(p)) // 递归，如果是文件夹，就继续遍历该文件夹里面的文件
                }
            }
        }
        // 这里可以增加选择文件夹，然后添加方法遍历出文件夹下的所有文件，添加进path中
        // const filePaths: FileDirElement[] = []
        // paths.forEach(p => {
        //     fsSync.stat(p, (error, stats) => {
        //         if (error) {
        //             console.warn('获取文件stats失败')
        //             return
        //         }
        //         const isFile = stats.isFile() // 是否为文件
        //         const isDir = stats.isDirectory() // 是否为文件夹
        //         if (isFile) {
        //             const fileDirElement = new FileDirElement(p, '')
        //             filePaths.push(fileDirElement)
        //         }
        //         if (isDir) {
        //             const filePathArr: string[] = []
        //             this.fileDisplay(filePathArr, p) // 递归，如果是文件夹，就继续遍历该文件夹里面的文件
        //             filePathArr.map(p1 => {
        //                 console.log(p1)
        //                 const fileDirElement = new FileDirElement(p1, p1.replace(p, ''))
        //                 filePaths.push(fileDirElement)
        //             })

        //         }
        //     })
        // })
        // const filePathArr: string[] = []
        // for (const p of paths) {
        //     // const p = paths[i]
        //     fsSync.stat(p, async (error, stats) => {
        //         if (error) {
        //             console.warn('获取文件stats失败')
        //             return
        //         }
        //         const isFile = stats.isFile() // 是否为文件
        //         const isDir = stats.isDirectory() // 是否为文件夹
        //         if (isFile) {
        //             const fileDirElement = new FileDirElement(p, '')
        //             filePaths.push(fileDirElement)
        //         }
        //         if (isDir) {
        //             // const filePathArr: string[] = []
        //             this.fileDisplay(filePaths, p, p) // 递归，如果是文件夹，就继续遍历该文件夹里面的文件
        //             // 下面这种方式，数组不会修改，不知道什么原因
        //             // console.log(filePathArr)
        //             // filePaths.concat(filePathArr.map(p1 => {
        //             //     console.log(p1)
        //             //     const fileDirElement = new FileDirElement(p1, p1.replace(p, ''))
        //             //     return fileDirElement
        //             // }))
        //             // for (const p1 of filePathArr) {
        //             //     console.log(p1)
        //             //     filePaths.push(new FileDirElement(p1, p1.replace(p, '')))
        //             // }

        //         }
        //     })
        // }
        console.log(filePaths)
        return Promise.all(filePaths.map(async p => {
            const transfer = new ElectronFileUpload(p.getFilePath(), this.electron, p.getFileDir())
            await wrapPromise(this.zone, transfer.open())
            this.fileTransferStarted.next(transfer)
            return transfer
        }))

    }

    fileDisplay (filePaths: FileDirElement[], filePath: string, basePath: string): void {
        // 根据文件路径读取文件，返回一个文件列表
        const files = fsSync.readdirSync(filePath)
        // 遍历读取到的文件列表
        files.forEach(filename => {
            // path.join得到当前文件的绝对路径
            const filepath = path.join(filePath, filename)
            // 根据文件路径获取文件信息
            const stats = fsSync.statSync(filepath)
            const isFile = stats.isFile() // 是否为文件
            const isDir = stats.isDirectory() // 是否为文件夹
            if (isFile && !filepath.endsWith('.DS_Store')) {
                // console.log(filepath)
                filePaths.push(new FileDirElement(filepath, filepath.replace(basePath, ''))) //如果是文件，添加到filePaths中
            }
            if (isDir) {
                this.fileDisplay(filePaths, filepath, basePath) // 递归，如果是文件夹，就继续遍历该文件夹里面的文件；
            }
        })
    }

    async fileSearch (filePaths: string[], dirPath: string): Promise<void> {
        const files = await this.fsReadDir(dirPath)
        const promises = files.map( file => {
            return this.fsStat(path.join(dirPath, file))
        })

        const datas = await Promise.all(promises).then(stats => {
            for (let i = 0; i < files.length; i += 1) {files[i] = path.join(dirPath, files[i])}
            return { stats, files }
        })

        datas.stats.forEach(stat => {
            const isFile = stat.isFile()
            const isDir = stat.isDirectory()
            if (isDir) {
                this.fileSearch(filePaths, datas.files[datas.stats.indexOf(stat)])
            }
            if (isFile) {
                filePaths.push(datas.files[datas.stats.indexOf(stat)])
            }
        })

    }

    fsReadDir (dir: string): Promise<string[]> {
        return new Promise<string[]>((resolve, reject) => {
            fsSync.readdir(dir, (err, files) => {
                if (err) {reject(err)}
                resolve(files)
            })
        })
    }

    fsStat (filePath: string): Promise<fsSync.Stats> {
        return new Promise<fsSync.Stats>((resolve, reject) => {
            fsSync.stat(filePath, (err, stat) => {
                if (err) {reject(err)}
                resolve(stat)
            })
        })
    }

    async startDownload (name: string, mode: number, size: number, filePath?: string): Promise<FileDownload|null> {
        if (!filePath) {
            const result = await this.electron.dialog.showSaveDialog(
                this.hostWindow.getWindow(),
                {
                    defaultPath: name,
                },
            )
            if (!result.filePath) {
                return null
            }
            filePath = result.filePath
        }
        const transfer = new ElectronFileDownload(filePath, mode, size, this.electron)
        await wrapPromise(this.zone, transfer.open())
        this.fileTransferStarted.next(transfer)
        return transfer
    }

    setErrorHandler (handler: (_: any) => void): void {
        this.electron.ipcRenderer.on('uncaughtException', (_$event, err) => {
            handler(err)
        })
    }
}

class FileDirElement {
    constructor (private filePath: string, private fileDir: string) {

    }

    getFilePath () {
        return this.filePath
    }

    getFileDir () {
        return this.fileDir
    }
}

class ElectronFileUpload extends FileUpload {
    private size: number
    private mode: number
    private file: fs.FileHandle
    private buffer: Buffer
    private powerSaveBlocker = 0

    constructor (private filePath: string, private electron: ElectronService, private dir?) {
        super()
        this.buffer = Buffer.alloc(256 * 1024)
        this.powerSaveBlocker = electron.powerSaveBlocker.start('prevent-app-suspension')
    }

    async open (): Promise<void> {
        const stat = await fs.stat(this.filePath)
        this.size = stat.size
        this.mode = stat.mode
        this.file = await fs.open(this.filePath, 'r')
    }
    getRelativeDir (): string {
        return this.dir
    }

    getName (): string {
        if (this.dir && this.dir !== '') {
            // if (this.dir.startWith('/')) {
            //     return this.dir.substring(1, -1)
            // }
            return this.dir
        } else {
            return path.basename(this.filePath)
        }
    }

    getMode (): number {
        return this.mode
    }

    getSize (): number {
        return this.size
    }

    async read (): Promise<Buffer> {
        const result = await this.file.read(this.buffer, 0, this.buffer.length, null)
        this.increaseProgress(result.bytesRead)
        return this.buffer.slice(0, result.bytesRead)
    }

    close (): void {
        this.electron.powerSaveBlocker.stop(this.powerSaveBlocker)
        this.file.close()
    }
}

class ElectronFileDownload extends FileDownload {
    private file: fs.FileHandle
    private powerSaveBlocker = 0

    constructor (
        private filePath: string,
        private mode: number,
        private size: number,
        private electron: ElectronService,
    ) {
        super()
        this.powerSaveBlocker = electron.powerSaveBlocker.start('prevent-app-suspension')
    }

    async open (): Promise<void> {
        this.file = await fs.open(this.filePath, 'w', this.mode)
    }

    getName (): string {
        return path.basename(this.filePath)
    }

    getMode (): number {
        return this.mode
    }

    getSize (): number {
        return this.size
    }

    async write (buffer: Buffer): Promise<void> {
        let pos = 0
        while (pos < buffer.length) {
            const result = await this.file.write(buffer, pos, buffer.length - pos, null)
            this.increaseProgress(result.bytesWritten)
            pos += result.bytesWritten
        }
    }

    close (): void {
        this.electron.powerSaveBlocker.stop(this.powerSaveBlocker)
        this.file.close()
    }
}
