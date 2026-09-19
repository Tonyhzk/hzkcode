#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
backup.py - 项目备份脚本

支持指定文件/文件夹打包，支持通配符和排除规则
命名格式: YYYYMMDDHHMM_项目名.zip
"""

import os
import zipfile
from datetime import datetime
from pathlib import Path
import fnmatch
import glob

# ==================== 常量配置 ====================

# 压缩包后缀名称
PROJECT_NAME = "project"

# 备份目录（相对于脚本所在目录）
BACKUP_DIR = Path("0_Backup")

# 要打包的文件夹（支持相对路径）
FOLDERS_TO_BACKUP = [
    "",
    "src",
]

# 要打包的文件（支持相对路径和通配符，如 *.bat）
FILES_TO_BACKUP = [
    "",
    "*.*",
    # "README.md",
]

# 要跳过的文件夹（支持相对路径和通配符）
FOLDERS_TO_SKIP = [
    "",
    "__pycache__",
    ".pycache",
    "node_modules",
    ".git",
]

# 要跳过的文件（支持相对路径和通配符）
FILES_TO_SKIP = [
    "",
    "setup_claude_dir.py",
    "*.pyc",
    "*.pyo",
    ".DS_Store",
    "*.db",
]

# ==================== 功能函数 ====================


def match_pattern(path_str, patterns):
    """检查路径是否匹配任一模式"""
    path = Path(path_str)
    for pattern in patterns:
        # 支持通配符匹配
        if fnmatch.fnmatch(path.name, pattern):
            return True
        # 支持完整路径匹配
        if fnmatch.fnmatch(str(path), pattern):
            return True
    return False


def collect_files_from_folders(folders):
    """从文件夹列表中收集所有文件和文件夹路径"""
    all_paths = []

    for folder in folders:
        folder_path = Path(folder)
        if not folder_path.exists():
            print(f"警告: 文件夹不存在 - {folder}")
            continue

        print(f"  扫描文件夹: {folder}/")

        # 添加文件夹本身
        all_paths.append(folder_path)

        # 遍历文件夹内容
        for root, dirs, files in os.walk(folder_path):
            root_path = Path(root)

            # 检查是否需要跳过当前目录
            if match_pattern(root_path, FOLDERS_TO_SKIP):
                dirs[:] = []  # 不再深入子目录
                continue

            # 过滤掉要跳过的子目录
            dirs[:] = [d for d in dirs if not match_pattern(Path(root) / d, FOLDERS_TO_SKIP)]

            # 添加目录
            all_paths.append(root_path)

            # 添加文件
            for file in files:
                file_path = root_path / file
                all_paths.append(file_path)

    return all_paths


def collect_files_from_patterns(patterns):
    """从文件模式列表中收集文件（支持通配符）"""
    all_files = []

    for pattern in patterns:
        # 使用 glob 支持通配符
        matched_files = glob.glob(pattern, recursive=True)
        for file_path in matched_files:
            path = Path(file_path)
            if path.exists() and path.is_file():
                all_files.append(path)
                print(f"  匹配文件: {file_path}")

    return all_files


def filter_paths(paths, skip_files, skip_folders):
    """过滤掉要跳过的文件和文件夹"""
    filtered_paths = []

    for path in paths:
        # 检查是否是要跳过的文件
        if path.is_file() and match_pattern(path, skip_files):
            continue

        # 检查是否是要跳过的文件夹
        if path.is_dir() and match_pattern(path, skip_folders):
            continue

        filtered_paths.append(path)

    return filtered_paths


def create_backup():
    """创建项目备份"""

    # 创建备份目录
    BACKUP_DIR.mkdir(exist_ok=True)

    print("=" * 60)
    print(f"项目备份工具 - {PROJECT_NAME}")
    print("=" * 60)

    # 第一步：收集所有要打包的文件和文件夹
    print("\n[步骤 1/4] 收集文件和文件夹...")
    all_paths = []

    # 从文件夹中收集
    if FOLDERS_TO_BACKUP:
        print("从文件夹收集:")
        all_paths.extend(collect_files_from_folders(FOLDERS_TO_BACKUP))

    # 从文件模式中收集
    if FILES_TO_BACKUP:
        print("从文件模式收集:")
        all_paths.extend(collect_files_from_patterns(FILES_TO_BACKUP))

    if not all_paths:
        print("错误: 没有找到任何要打包的文件")
        return False

    print(f"  共收集到 {len(all_paths)} 个路径")

    # 第二步：应用排除规则
    print("\n[步骤 2/4] 应用排除规则...")
    filtered_paths = filter_paths(all_paths, FILES_TO_SKIP, FOLDERS_TO_SKIP)
    print(f"  排除后剩余 {len(filtered_paths)} 个路径")

    # 去重并排序
    filtered_paths = sorted(set(filtered_paths))

    # 第三步：显示要打包的内容，等待用户确认
    print("\n[步骤 3/4] 要打包的内容:")
    print("-" * 60)

    # 分类显示
    folders = [p for p in filtered_paths if p.is_dir()]
    files = [p for p in filtered_paths if p.is_file()]

    # 计算总大小
    total_size = sum(f.stat().st_size for f in files)

    # 格式化大小显示
    if total_size < 1024:
        size_str = f"{total_size} B"
    elif total_size < 1024 * 1024:
        size_str = f"{total_size / 1024:.2f} KB"
    elif total_size < 1024 * 1024 * 1024:
        size_str = f"{total_size / (1024 * 1024):.2f} MB"
    else:
        size_str = f"{total_size / (1024 * 1024 * 1024):.2f} GB"

    print(f"\n文件夹 ({len(folders)} 个):")
    for folder in folders[:500]:  # 最多显示20个
        print(f"  📁 {folder}")
    if len(folders) > 500:
        print(f"  ... 还有 {len(folders) - 500} 个文件夹")

    print(f"\n文件 ({len(files)} 个):")
    for file in files[:500]:  # 最多显示20个
        size_kb = file.stat().st_size / 1024
        print(f"  📄 {file} ({size_kb:.1f} KB)")
    if len(files) > 500:
        print(f"  ... 还有 {len(files) - 500} 个文件")

    print("-" * 60)
    print(f"总计: {len(folders)} 个文件夹, {len(files)} 个文件, 总大小: {size_str}")

    # 读取版本号（默认为空，为空则不添加版本号后缀）
    version = ""
    version_file = Path("VERSION")
    if version_file.exists():
        version = version_file.read_text(encoding='utf-8').strip()

    # 生成备份文件名
    timestamp = datetime.now().strftime("%Y%m%d%H%M")
    if version:
        backup_name = f"{timestamp}_{PROJECT_NAME}_v{version}.zip"
    else:
        backup_name = f"{timestamp}_{PROJECT_NAME}.zip"
    backup_path = BACKUP_DIR / backup_name

    # 显示打包信息
    print(f"\n版本号: {version if version else '无'}")
    print(f"文件名: {backup_name}")

    # 用户确认
    print("\n是否继续打包? (y/n): ", end="")
    user_input = input().strip().lower()
    if user_input not in ['y', 'yes', '是']:
        print("已取消打包")
        return False

    # 第四步：执行打包
    print("\n[步骤 4/4] 开始打包...")

    # 创建 zip 文件
    print(f"正在创建备份: {backup_name}")

    with zipfile.ZipFile(backup_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
        for path in filtered_paths:
            # 显示进度
            if path.is_file():
                size_kb = path.stat().st_size / 1024
                print(f"  添加: {path} ({size_kb:.1f} KB)")
            else:
                print(f"  添加: {path}/")

            # 写入 zip
            zipf.write(path, path)

    # 获取文件大小
    size_mb = backup_path.stat().st_size / (1024 * 1024)

    print("\n" + "=" * 60)
    print("备份完成!")
    print(f"  文件: {backup_path}")
    print(f"  大小: {size_mb:.2f} MB")
    print("=" * 60)

    return True


if __name__ == "__main__":
    create_backup()
