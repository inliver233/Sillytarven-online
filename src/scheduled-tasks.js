import cron from 'node-cron';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import { getAllUserHandles, getUserDirectories } from './users.js';
import { onDrain } from './process-lifecycle.js';

/**
 * 定时任务管理器
 */
class ScheduledTasksManager {
    constructor() {
        this.tasks = new Map(); // 存储所有定时任务
        this.configPath = path.join(process.cwd(), 'config.yaml');
        this.loadTasks();
    }

    /**
     * 从配置文件加载定时任务
     */
    loadTasks() {
        try {
            if (!fs.existsSync(this.configPath)) {
                console.warn('Config file not found, skipping scheduled tasks load');
                return;
            }

            const configContent = fs.readFileSync(this.configPath, 'utf8');
            const config = yaml.parse(configContent);

            if (config.scheduledTasks && config.scheduledTasks.clearAllBackups) {
                const taskConfig = config.scheduledTasks.clearAllBackups;
                if (taskConfig.enabled && taskConfig.cronExpression) {
                    this.startClearAllBackupsTask(taskConfig.cronExpression);
                    console.log(`已加载定时清理备份任务: ${taskConfig.cronExpression}`);
                }
            }
        } catch (error) {
            console.error('加载定时任务配置失败:', error);
        }
    }

    /**
     * 启动清理所有用户备份文件的定时任务
     * @param {string} cronExpression - Cron表达式
     * @returns {boolean} 是否成功启动
     */
    startClearAllBackupsTask(cronExpression) {
        try {
            // 验证cron表达式
            if (!cron.validate(cronExpression)) {
                console.error('无效的cron表达式:', cronExpression);
                return false;
            }

            // 如果任务已存在，先停止
            if (this.tasks.has('clearAllBackups')) {
                this.stopTask('clearAllBackups');
            }

            // 创建新任务
            const task = cron.schedule(cronExpression, async () => {
                console.log(`[定时任务] 开始清理所有用户备份文件 - ${new Date().toLocaleString()}`);
                await this.executeClearAllBackups();
            }, {
                timezone: 'Asia/Shanghai', // 可以根据需要调整时区
            });

            this.tasks.set('clearAllBackups', {
                task: task,
                cronExpression: cronExpression,
                type: 'clearAllBackups',
                enabled: true,
            });

            console.log(`定时清理备份任务已启动: ${cronExpression}`);
            return true;
        } catch (error) {
            console.error('启动定时清理备份任务失败:', error);
            return false;
        }
    }

    /**
     * 执行清理所有用户备份文件
     */
    async executeClearAllBackups() {
        try {
            const userHandles = await getAllUserHandles();
            let totalDeletedSize = 0;
            let totalDeletedFiles = 0;

            for (const handle of userHandles) {
                try {
                    const directories = getUserDirectories(handle);
                    let userDeletedSize = 0;
                    let userDeletedFiles = 0;

                    // 只清理备份目录
                    if (fs.existsSync(directories.backups)) {
                        const backupsSize = await this.calculateDirectorySize(directories.backups);
                        userDeletedSize += backupsSize;
                        const files = await fs.promises.readdir(directories.backups);
                        userDeletedFiles += files.length;
                        await fs.promises.rm(directories.backups, { recursive: true, force: true });
                        await fs.promises.mkdir(directories.backups, { recursive: true });
                    }

                    totalDeletedSize += userDeletedSize;
                    totalDeletedFiles += userDeletedFiles;

                    console.info(`[定时任务] 已清理用户 ${handle} 的备份: ${userDeletedFiles} 个文件, ${(userDeletedSize / 1024 / 1024).toFixed(2)} MB`);
                } catch (error) {
                    console.error(`[定时任务] 清理用户 ${handle} 的备份失败:`, error);
                }
            }

            console.log(`[定时任务] 清理完成: 共清理 ${userHandles.length} 个用户的备份文件，共 ${totalDeletedFiles} 个文件，释放 ${(totalDeletedSize / 1024 / 1024).toFixed(2)} MB 空间`);
        } catch (error) {
            console.error('[定时任务] 执行清理所有备份文件失败:', error);
        }
    }

    /**
     * 递归计算目录大小（字节）
     * @param {string} dirPath - 目录路径
     * @returns {Promise<number>} - 目录大小（字节）
     */
    async calculateDirectorySize(dirPath) {
        let totalSize = 0;

        try {
            if (!fs.existsSync(dirPath)) {
                return 0;
            }

            const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);

                if (entry.isDirectory()) {
                    totalSize += await this.calculateDirectorySize(fullPath);
                } else {
                    const stats = await fs.promises.stat(fullPath);
                    totalSize += stats.size;
                }
            }
        } catch (error) {
            console.error(`计算目录大小失败 ${dirPath}:`, error);
        }

        return totalSize;
    }

    /**
     * 停止指定任务
     * @param {string} taskName - 任务名称
     */
    stopTask(taskName) {
        const taskInfo = this.tasks.get(taskName);
        if (taskInfo && taskInfo.task) {
            taskInfo.task.stop();
            this.tasks.delete(taskName);
            console.log(`定时任务已停止: ${taskName}`);
        }
    }

    /**
     * 停止所有任务
     */
    stopAllTasks() {
        for (const [taskName] of this.tasks) {
            this.stopTask(taskName);
        }
    }

    /**
     * 获取任务状态
     * @param {string} taskName - 任务名称
     * @returns {Object|null} 任务信息
     */
    getTaskStatus(taskName) {
        const taskInfo = this.tasks.get(taskName);
        if (!taskInfo) {
            return null;
        }

        return {
            enabled: taskInfo.enabled,
            cronExpression: taskInfo.cronExpression,
            type: taskInfo.type,
            running: taskInfo.task && taskInfo.task.running !== undefined ? taskInfo.task.running : true,
        };
    }

    /**
     * 获取所有任务状态
     * @returns {Object} 所有任务状态
     */
    getAllTasksStatus() {
        const status = {};
        for (const [taskName] of this.tasks) {
            status[taskName] = this.getTaskStatus(taskName);
        }
        return status;
    }

    /**
     * 保存定时任务配置到 config.yaml
     * @param {Object} taskConfig - 任务配置
     * @returns {boolean} 是否成功保存
     */
    saveTaskConfig(taskConfig) {
        try {
            let config = {};

            if (fs.existsSync(this.configPath)) {
                const configContent = fs.readFileSync(this.configPath, 'utf8');
                config = yaml.parse(configContent);
            }

            if (!config.scheduledTasks) {
                config.scheduledTasks = {};
            }

            config.scheduledTasks.clearAllBackups = {
                enabled: taskConfig.enabled || false,
                cronExpression: taskConfig.cronExpression || '',
            };

            const newConfigContent = yaml.stringify(config);
            fs.writeFileSync(this.configPath, newConfigContent, 'utf8');

            console.log('定时任务配置已保存到 config.yaml');
            return true;
        } catch (error) {
            console.error('保存定时任务配置失败:', error);
            return false;
        }
    }

    /**
     * 从配置文件读取定时任务配置
     * @returns {Object|null} 任务配置
     */
    getTaskConfig() {
        try {
            if (!fs.existsSync(this.configPath)) {
                return null;
            }

            const configContent = fs.readFileSync(this.configPath, 'utf8');
            const config = yaml.parse(configContent);

            if (config.scheduledTasks && config.scheduledTasks.clearAllBackups) {
                return config.scheduledTasks.clearAllBackups;
            }

            return null;
        } catch (error) {
            console.error('读取定时任务配置失败:', error);
            return null;
        }
    }
}

// 创建全局定时任务管理器实例
const scheduledTasksManager = new ScheduledTasksManager();

// Hot reload: the new server runs the tasks from now on.
onDrain(() => scheduledTasksManager.stopAllTasks());
// On shutdown the server stops the tasks before it exits (server-main.js). Exiting
// here would cut short its saving of in-memory state.

export default scheduledTasksManager;
export { ScheduledTasksManager };

