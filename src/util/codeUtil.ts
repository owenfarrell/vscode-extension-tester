'use strict';

import request = require("request");
import * as fs from 'fs-extra';
import * as path from 'path';
import * as child_process from 'child_process';
import { VSRunner } from "../suite/runner";
import { Unpack } from "./unpack";

export enum ReleaseQuality {
    Stable = 'stable',
    Insider = 'insider'
}

/**
 * Handles the VS Code instance used for testing.
 * Includes downloading, unpacking, launching, and version checks.
 */
export class CodeUtil {
    private codeFolder: string;
    private downloadPlatform: string;
    private downloadFolder: string;
    private releaseType: ReleaseQuality;
    private executablePath!: string;
    private cliPath!: string;
    private cliEnv!: string;
    private availableVersions: string[];
    private extensionsFolder: string | undefined;

    /**
     * Create an instance of code handler 
     * @param folder Path to folder where all the artifacts will be stored.
     * @param extensionsFolder Path to use as extensions directory by VSCode
     */
    constructor(folder: string = 'test-resources', type: ReleaseQuality = ReleaseQuality.Stable, extensionsFolder?: string) {
        this.availableVersions = [];
        this.downloadPlatform = this.getPlatform();
        this.downloadFolder = path.resolve(folder);
        this.extensionsFolder = extensionsFolder ? path.resolve(extensionsFolder) : undefined;
        this.releaseType = type;

        if (type === ReleaseQuality.Stable) {
            this.codeFolder = path.join(this.downloadFolder, (process.platform === 'darwin')
                ? 'Visual Studio Code.app' : `VSCode-${this.downloadPlatform}`);
        } else {
            this.codeFolder = path.join(this.downloadFolder, (process.platform === 'darwin')
                ? 'Visual Studio Code - Insiders.app' : `VSCode-${this.downloadPlatform}-insider`);
        }
        this.findExecutables();
    }

    /**
     * Get all versions for the given release stream
     */
    async getVSCodeVersions(): Promise<string[]> {
        const apiUrl = `https://vscode-update.azurewebsites.net/api/releases/${this.releaseType}`;
        const headers = {
            'user-agent': 'nodejs'
        };
    
        return new Promise<string>((resolve, reject) => {
            request.get({ url: apiUrl, headers: headers }, (error, response, body) => {
                if (!error && response && response.statusCode >= 400) {
                    error = new Error(`Request returned status code: ${response.statusCode}\nDetails: ${response.body}`);
                    reject(error);
                }
                resolve(body);
            });
        }).then((json) => {
            return JSON.parse(json);
        });
    }

    /**
     * Download and unpack VS Code for testing purposes
     * 
     * @param version VS Code version to get, default latest
     */
    async downloadVSCode(version: string = 'latest'): Promise<void> {
        await this.checkCodeVersion(version);

        const literalVersion = version === 'latest' ? this.availableVersions[0] : version;
        if (!fs.existsSync(this.executablePath) || await this.getExistingCodeVersion() !== literalVersion) {
            fs.mkdirpSync(this.downloadFolder);

            const url = ['https://vscode-update.azurewebsites.net', version, this.downloadPlatform, this.releaseType].join('/');
            const isTarGz = this.downloadPlatform.indexOf('linux') > -1;
            const fileName = `${path.basename(url)}.${isTarGz ? 'tar.gz' : 'zip'}`;
    
            console.log(`Downloading VS Code from: ${url}`);
            await new Promise<void>((resolve) => {
                request.get(url)
                    .pipe(fs.createWriteStream(path.join(this.downloadFolder, fileName)))
                    .on('close', resolve);
            });
            console.log(`Downloaded VS Code into ${path.join(this.downloadFolder, fileName)}`);
    
            console.log(`Unpacking VS Code into ${this.downloadFolder}`);
            let target = this.downloadFolder;
            if (process.platform === 'win32') {
                target = path.join(this.downloadFolder, `VSCode-${this.downloadPlatform}`);
                fs.mkdirpSync(target);
            }
            await Unpack.unpack(path.join(this.downloadFolder, fileName), target);
            console.log('Success!');
        } else {
            console.log('VS Code exists in local cache, skipping download');
        }
    }

    /**
     * Install your extension into the test instance of VS Code
     */
    installExtension(vsix?: string): void {
        const pjson = require(path.resolve('package.json'));
        const vsixPath = path.resolve(vsix ? vsix : `${pjson.name}-${pjson.version}.vsix`);
        let command = `${this.cliEnv} "${this.executablePath}" "${this.cliPath}" --install-extension "${vsixPath}"`;
        if (this.extensionsFolder) {
            command += ` --extensions-dir=${this.extensionsFolder}`;
        }
        child_process.execSync(command, { stdio: 'inherit' });
    }

    /**
     * Download a vsix file
     * @param vsixURL URL of the vsix file
     */
    async downloadExtension(vsixURL: string): Promise<string> {
        fs.mkdirpSync(this.downloadFolder);
        const fileName = path.basename(vsixURL);
        const target = path.join(this.downloadFolder, fileName);
        if (!fileName.endsWith('.vsix')) {
            throw new Error('The URL does not point to a vsix file');
        }

        console.log(`Downloading ${fileName}`);
        await new Promise<void>((resolve) => {
            request.get(vsixURL)
                .pipe(fs.createWriteStream(target))
                .on('close', resolve);
        });
        console.log('Success!');
        return target;
    }

    /**
     * Package extension into a vsix file
     * @param useYarn false to use npm as packaging system, true to use yarn instead
     */
    packageExtension(useYarn?: boolean): void {
        let binFolder = path.join(__dirname, '..', '..', 'node_modules', '.bin');
        if (!fs.existsSync(binFolder)) {
            binFolder = path.join('node_modules', '.bin');
        }
        const cliCall = `${path.join(binFolder, 'vsce')} package${useYarn ? ' --yarn' : ''}`;

        child_process.execSync(cliCall, { stdio: 'inherit' });
    }

    /**
     * Uninstall the tested extension from the test instance of VS Code
     */
    uninstallExtension(cleanup?: boolean): void {
        const pjson = require(path.resolve('package.json'));
        const extension = `${pjson.publisher}.${pjson.name}`;
        const helper = `vscode-extension-tester.api-handler`;
        let command2 = `${this.cliEnv} "${this.executablePath}" "${this.cliPath}" --uninstall-extension "${helper}"`;
        if (this.extensionsFolder) {
            command2 += ` --extensions-dir=${this.extensionsFolder}`;
        }
        child_process.execSync(command2, { stdio: 'inherit' });

        if (cleanup) {
            let command = `${this.cliEnv} "${this.executablePath}" "${this.cliPath}" --uninstall-extension "${extension}"`;
            if (this.extensionsFolder) {
                command += ` --extensions-dir=${this.extensionsFolder}`;
            }
            child_process.execSync(command, { stdio: 'inherit' });
        }
    }

    /**
     * Run tests in your test environment using mocha
     * 
     * @param testFilesPattern glob pattern of test files to run
     * @param settings path to custom settings json file
     * @param vscodeVersion version of VSCode to test against, default latest
     */
    async runTests(testFilesPattern: string, vscodeVersion: string = 'latest', settings: string = '', cleanup?: boolean, config?: string): Promise<void> {
        await this.checkCodeVersion(vscodeVersion);
        const literalVersion = vscodeVersion === 'latest' ? this.availableVersions[0] : vscodeVersion;

        // add chromedriver to process' path
        const finalEnv: NodeJS.ProcessEnv = {};
        Object.assign(finalEnv, process.env);
        const key = 'PATH';
        finalEnv[key] = [this.downloadFolder, process.env[key]].join(path.delimiter);

        process.env = finalEnv;
        process.env.TEST_RESOURCES = this.downloadFolder;
        process.env.EXTENSIONS_FOLDER = this.extensionsFolder;
        const runner = new VSRunner(this.executablePath, literalVersion, this.parseSettings(settings), cleanup, config);
        runner.runTests(testFilesPattern, this);
    }

    /**
     * Finds the version of chromium used for given VS Code version.
     * Works only for versions 1.30+, older versions need to be checked manually
     * 
     * @param codeVersion version of VS Code, default latest
     * @param quality release stream, default stable
     */
    async getChromiumVersion(codeVersion: string = 'latest'): Promise<string> {
        await this.checkCodeVersion(codeVersion);
        const literalVersion = codeVersion === 'latest' ? this.availableVersions[0] : codeVersion;
        let revision = literalVersion;
        if (literalVersion.endsWith('-insider')) {
            if (codeVersion === 'latest') {
                revision = 'master';
            } else {
                revision = literalVersion.substring(0, literalVersion.indexOf('-insider'));
                revision = `release/${revision.substring(0, revision.lastIndexOf('.'))}`;
            }
        } else {
            revision = `release/${revision.substring(0, revision.lastIndexOf('.'))}`;
        }

        const fileName = 'manifest.json';
        const url = `https://raw.githubusercontent.com/Microsoft/vscode/${revision}/cgmanifest.json`;
        await new Promise<void>((resolve) => {
            request.get(url)
                .pipe(fs.createWriteStream(path.join(this.downloadFolder, fileName)))
                .on('close', resolve);
        });
        const manifest = require(path.join(this.downloadFolder, fileName));
        return manifest.registrations[0].version;
    }

    /**
     * Check if given version is available in the given stream
     */
    private async checkCodeVersion(vscodeVersion: string): Promise<void> {
        if (this.availableVersions.length < 1) {
            this.availableVersions = await this.getVSCodeVersions();
        }
        if (vscodeVersion !== 'latest' && this.availableVersions.indexOf(vscodeVersion) < 0) {
            throw new Error(`Version ${vscodeVersion} is not available in ${this.releaseType} stream`);
        }
    }

    /**
     * Check what VS Code version is present in the testing folder
     */
    private getExistingCodeVersion(): Promise<string> {
        const command = [this.cliEnv, `"${this.executablePath}"`, `"${this.cliPath}"`, '-v'].join(' ');
        return new Promise<string>((resolve, reject) => {
            child_process.exec(command, (err, stdout) => {
                if (err) return reject(err);
                resolve(stdout.split('\n')[0]);
            });
        })
    }

    /**
     * Construct the platform string based on OS
     */
    private getPlatform(): string {
        let platform: string = process.platform;
        const arch = process.arch;
        this.cliEnv = 'ELECTRON_RUN_AS_NODE=1';

        if (platform === 'linux') {
            platform += arch === 'x64' ? `-${arch}` : `-ia32`;
        } else if (platform === 'win32') {
            platform += arch === 'x64' ? `-${arch}` : '';
            platform += '-archive';
            this.cliEnv = `set ${this.cliEnv} &&`;
        }

        return platform;
    }

    /**
     * Setup paths specific to used OS
     */
    private findExecutables(): void {
        this.cliPath = path.join(this.codeFolder, 'resources', 'app', 'out', 'cli.js');
        switch (process.platform) {
            case 'darwin':
                this.executablePath = path.join(this.codeFolder, 'Contents', 'MacOS', 'Electron');
                this.cliPath = path.join(this.codeFolder, 'Contents', 'Resources', 'app', 'out', 'cli.js');
                break;
            case 'win32':
                this.executablePath = path.join(this.codeFolder, 'Code.exe');
                if (this.releaseType === ReleaseQuality.Insider) {
                    this.executablePath = path.join(this.codeFolder, 'Code - Insiders.exe');
                }
                break;
            case 'linux':
                this.executablePath = path.join(this.codeFolder, 'code');
                if (this.releaseType === ReleaseQuality.Insider) {
                    this.executablePath = path.join(this.codeFolder, 'code-insiders');
                }
                break;
        }
    }

    /**
     * Parse JSON from a file
     * @param path path to json file
     */
    private parseSettings(path: string): Object {
        if (!path) {
            return {};
        }
        let text = '';
        try {
            text = fs.readFileSync(path).toString();
        } catch (err) {
            throw new Error(`Unable to read settings from ${path}:\n ${err}`);
        }
        try {
            return JSON.parse(text);
        } catch (err) {
            throw new Error(`Error parsing the settings file from ${path}:\n ${err}`);
        }
    }
}