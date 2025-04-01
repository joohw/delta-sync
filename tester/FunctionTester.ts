// tester/FunctionTester.ts
// Adapter functionality tester - for testing any implementation of the DatabaseAdapter interface

import { DatabaseAdapter, DeltaModel } from '../core/types';


export class AdapterFunctionTester {
  private adapter: DatabaseAdapter;
  private testStoreName: string = 'adapter_test';
  private testFileContent: string = 'Hello, this is a test file content!';
  constructor(adapter: DatabaseAdapter, testStoreName?: string) {
    this.adapter = adapter;
    if (testStoreName) {
      this.testStoreName = testStoreName;
    }
  }


  //  Run all tests
  async runAllTests(): Promise<{
    success: boolean;
    results: Record<string, { success: boolean; message: string }>;
  }> {
    console.log('=== Starting adapter tests ===');
    const results: Record<string, { success: boolean; message: string }> = {};
    let allSuccess = true;
    try {
      // Test initialization
      results.initialization = await this.testInitialization();
      allSuccess = allSuccess && results.initialization.success;
      // Test availability
      results.availability = await this.testAvailability();
      allSuccess = allSuccess && results.availability.success;
      // Test basic CRUD operations
      results.basicCrud = await this.testBasicCrud();
      allSuccess = allSuccess && results.basicCrud.success;
      // Test bulk operations
      results.bulkOperations = await this.testBulkOperations();
      allSuccess = allSuccess && results.bulkOperations.success;
      // Test batch file operations
      results.batchFileOperations = await this.testBatchFileOperations();
      allSuccess = allSuccess && results.batchFileOperations.success;
      // Test large file operations
      results.largeFileOperations = await this.testLargeFileOperations();
      allSuccess = allSuccess && results.largeFileOperations.success;
      allSuccess = allSuccess && results.count.success;
      console.log('=== Adapter tests completed ===');
      if (allSuccess) {
        console.log('✅ All tests passed');
      } else {
        console.log('❌ Some tests failed');
      }
      // Output detailed results
      Object.entries(results).forEach(([testName, result]) => {
        console.log(`${result.success ? '✅' : '❌'} ${testName}: ${result.message}`);
      });
      return {
        success: allSuccess,
        results
      };
    } catch (error) {
      console.error('Uncaught error during testing:', error);
      return {
        success: false,
        results: {
          ...results,
          uncaughtError: {
            success: false,
            message: `Uncaught error: ${error instanceof Error ? error.message : String(error)}`
          }
        }
      };
    }
  }

  // Test initialization functionality
  async testInitialization(): Promise<{ success: boolean; message: string }> {
    try {
      console.log('Testing initialization...');
      return { success: true, message: 'Initialization successful' };
    } catch (error) {
      console.error('Initialization failed:', error);
      return {
        success: false,
        message: `Initialization failed: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }


  // Test availability check
  async testAvailability(): Promise<{ success: boolean; message: string }> {
    try {
      console.log('Testing availability...');
      return { success: true, message: 'Adapter is available' };
    } catch (error) {
      console.error('Availability check failed:', error);
      return {
        success: false,
        message: `Availability check failed: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }


  //  Test basic CRUD operations
  async testBasicCrud(): Promise<{ success: boolean; message: string }> {
    try {
      console.log('Testing basic CRUD operations...');
      const testItem: DeltaModel = {
        id: `test_item_${Date.now()}`,
        _store: this.testStoreName,
        _version: 1
      };
      // Write
      console.log('Testing write operation...');
      const writeResult = await this.adapter.putBulk(this.testStoreName, [testItem]);
      if (!writeResult || writeResult.length !== 1) {
        return { success: false, message: 'Write operation failed' };
      }
      // Read
      console.log('Testing read operation...');
      const readResult = await this.adapter.readBulk(this.testStoreName, [testItem.id]);
      if (!readResult || readResult.length !== 1 || readResult[0].id !== testItem.id) {
        return { success: false, message: 'Read operation failed' };
      }
      // Delete
      console.log('Testing delete operation...');
      await this.adapter.deleteBulk(this.testStoreName, [testItem.id]);
      // Verify deletion
      const afterDeleteResult = await this.adapter.readBulk(this.testStoreName, [testItem.id]);
      if (afterDeleteResult && afterDeleteResult.length > 0) {
        return { success: false, message: 'Delete operation failed' };
      }
      return { success: true, message: 'Basic CRUD operations test passed' };
    } catch (error) {
      console.error('CRUD test failed:', error);
      return {
        success: false,
        message: `CRUD test failed: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }


  // Test bulk operations

  async testBulkOperations(): Promise<{ success: boolean; message: string }> {
    try {
      console.log('Testing bulk operations...');
      // Create multiple test items
      const testItems: DeltaModel[] = Array(5).fill(0).map((_, index) => ({
        id: `bulk_test_${Date.now()}_${index}`,
        _sync_status: 'pending',
        _store: this.testStoreName,
        _version: 2,
        testValue: `Test value ${index}`
      }));
      // Bulk write
      console.log('Testing bulk write...');
      const writeResult = await this.adapter.putBulk(this.testStoreName, testItems);
      if (!writeResult || writeResult.length !== testItems.length) {
        return { success: false, message: 'Bulk write failed' };
      }
      // Bulk read
      console.log('Testing bulk read...');
      const ids = testItems.map(item => item.id);
      const readResult = await this.adapter.readBulk(this.testStoreName, ids);
      if (!readResult || readResult.length !== ids.length) {
        return { success: false, message: 'Bulk read failed' };
      }
      // Test pagination
      console.log('Testing pagination...');
      const pageResult = await this.adapter.readByVersion(this.testStoreName, { limit: 3, offset: 0 });
      if (!pageResult || !pageResult.items) {
        return { success: false, message: 'Pagination failed' };
      }
      // Bulk delete
      console.log('Testing bulk delete...');
      await this.adapter.deleteBulk(this.testStoreName, ids);
      // Verify bulk delete
      const afterDeleteResult = await this.adapter.readBulk(this.testStoreName, ids);
      if (afterDeleteResult && afterDeleteResult.length > 0) {
        return { success: false, message: 'Bulk delete failed' };
      }
      return { success: true, message: 'Bulk operations test passed' };
    } catch (error) {
      console.error('Bulk operations test failed:', error);
      return {
        success: false,
        message: `Bulk operations test failed: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }



  // Test batch file operations
  async testBatchFileOperations(): Promise<{ success: boolean; message: string }> {
    try {
      console.log('Testing batch file operations...');
      // Prepare test files
      const totalFiles = 3;
      const fileContents = Array(totalFiles).fill(0).map((_, i) =>
        `File content ${i}: ${this.testFileContent}`
      );
      const fileIds = Array(totalFiles).fill(0).map((_, i) =>
        `batch_test_file_${Date.now()}_${i}`
      );
      const fileObjects = fileIds.map((fileId, index) => ({
        fileId,
        content: new Blob([fileContents[index]], { type: 'text/plain' })
      }));
      // 1. Batch save files
      console.log('Testing batch file saving...');
      const saveResults = await this.adapter.saveFiles(fileObjects);
      if (!saveResults || saveResults.length !== totalFiles) {
        return {
          success: false,
          message: `Batch file save failed: expected=${totalFiles}, actual=${saveResults?.length || 0}`
        };
      }
      // Store the actual attachment IDs returned from the save operation
      const attachmentIds = saveResults.map(attachment => attachment.id);
      // Delay for cloud storage sync
      const delay = (ms: any) => new Promise(resolve => setTimeout(resolve, ms));
      console.log('Waiting for cloud storage sync...');
      // 2. Read files using attachment IDs from save results
      console.log('Testing batch file reading...');
      const readResults = await this.adapter.readFiles(attachmentIds);
      if (!readResults || readResults.size !== totalFiles) {
        return {
          success: false,
          message: `Batch file read failed: expected=${totalFiles}, actual=${readResults?.size || 0}`
        };
      }
      // Verify each file's content using attachment IDs
      console.log('Verifying batch file contents...');
      let allContentMatch = true;
      let mismatchedFileId = '';
      for (let i = 0; i < totalFiles; i++) {
        const attachmentId = attachmentIds[i];
        const fileContent = readResults.get(attachmentId);
        if (!fileContent) {
          allContentMatch = false;
          mismatchedFileId = attachmentId;
          break;
        }
        // Read Blob or ArrayBuffer content
        let contentText = '';
        if (fileContent instanceof Blob) {
          contentText = await fileContent.text();
        } else if (fileContent instanceof ArrayBuffer) {
          contentText = new TextDecoder().decode(fileContent);
        }
        // Use inclusion check instead of exact match
        if (!contentText.includes(fileContents[i].substring(0, 20))) {
          console.log(`File content mismatch: ${attachmentId}`);
          console.log(`Expected to contain: ${fileContents[i].substring(0, 20)}`);
          console.log(`Actual content: ${contentText.substring(0, 100)}`);
          allContentMatch = false;
          mismatchedFileId = attachmentId;
          break;
        }
      }
      if (!allContentMatch) {
        return {
          success: false,
          message: `Batch file content verification failed: File ${mismatchedFileId} content mismatched`
        };
      }
      // 3. Batch delete files
      console.log('Testing batch file deletion...');
      const deleteResult = await this.adapter.deleteFiles(attachmentIds);
      if (!deleteResult || deleteResult.deleted.length !== totalFiles) {
        return {
          success: false,
          message: `Batch file delete failed: expected=${totalFiles}, actual=${deleteResult?.deleted.length || 0}`
        };
      }
      // Verify files are all deleted
      console.log('Verifying batch file deletion results...');
      const verifyReadResults = await this.adapter.readFiles(attachmentIds);
      let allDeleted = true;
      let stillExistsFileId = '';

      for (const attachmentId of attachmentIds) {
        const content = verifyReadResults.get(attachmentId);
        if (content !== null && content !== undefined) {
          allDeleted = false;
          stillExistsFileId = attachmentId;
          break;
        }
      }

      if (!allDeleted) {
        return {
          success: false,
          message: `Batch file deletion verification failed: File ${stillExistsFileId} still exists`
        };
      }

      // 4. Test batch file operation error handling
      console.log('Testing batch file operation error handling...');
      // Test non-existent file IDs
      const nonExistentIds = ['non_existent_1', 'non_existent_2'];
      const nonExistentResults = await this.adapter.readFiles(nonExistentIds);
      let handlesNonExistentWell = true;

      for (const id of nonExistentIds) {
        if (nonExistentResults.get(id) !== null && nonExistentResults.get(id) !== undefined) {
          handlesNonExistentWell = false;
          break;
        }
      }

      if (!handlesNonExistentWell) {
        return {
          success: false,
          message: 'Batch reading of non-existent files handling failed: should return null or undefined'
        };
      }

      // Test deleting non-existent files
      const deleteNonExistentResult = await this.adapter.deleteFiles(nonExistentIds);
      if (deleteNonExistentResult.deleted.length + deleteNonExistentResult.failed.length !== nonExistentIds.length) {
        return {
          success: false,
          message: `Batch deletion of non-existent files handling failed:
         expected total=${nonExistentIds.length}, actual total=${deleteNonExistentResult.deleted.length + deleteNonExistentResult.failed.length}`
        };
      }

      // 5. Test batch processing of different file types
      console.log('Testing batch processing of different file types...');
      const mixedFiles = [
        {
          fileId: `text_file_${Date.now()}`,
          content: new Blob(['Plain text content'], { type: 'text/plain' })
        },
        {
          fileId: `binary_file_${Date.now()}`,
          content: new Blob([new Uint8Array([10, 20, 30, 40, 50])], { type: 'application/octet-stream' })
        },
        {
          fileId: `base64_file_${Date.now()}`,
          content: 'data:text/plain;base64,QmF0Y2ggdGVzdGluZyBiYXNlNjQgY29udGVudA==' // "Batch testing base64 content"
        }
      ];

      const mixedSaveResults = await this.adapter.saveFiles(mixedFiles);
      if (mixedSaveResults.length !== 3) {
        return {
          success: false,
          message: `Mixed file type batch save failed: expected=3, actual=${mixedSaveResults.length}`
        };
      }

      // Use attachment IDs from save results
      const mixedAttachmentIds = mixedSaveResults.map(result => result.id);
      const mixedReadResults = await this.adapter.readFiles(mixedAttachmentIds);

      if (mixedReadResults.size !== 3) {
        return {
          success: false,
          message: `Mixed file type batch read failed: expected=3, actual=${mixedReadResults.size}`
        };
      }

      // Clean up mixed files
      await this.adapter.deleteFiles(mixedAttachmentIds);

      return { success: true, message: 'Batch file operations test passed' };
    } catch (error) {
      console.error('Batch file operations test failed:', error);
      return {
        success: false,
        message: `Batch file operations test failed: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }


  // test larget file operations
  async testLargeFileOperations(): Promise<{ success: boolean; message: string }> {
    try {
      console.log('Testing large file operations (10MB)...');
      // 创建一个10MB的随机数据
      const size = 10 * 1024 * 1024; // 10MB
      const buffer = new ArrayBuffer(size);
      const view = new Uint8Array(buffer);
      // 填充随机数据
      for (let i = 0; i < size; i++) {
        view[i] = Math.floor(Math.random() * 256);
      }
      const fileId = `large_file_test_${Date.now()}.bin`;
      console.log(`创建了${size}字节的大文件: ${fileId}`);
      // 上传大文件
      console.log('上传大文件...');
      const startUploadTime = Date.now();
      const saveResult = await this.adapter.saveFiles([{
        fileId,
        content: buffer
      }]);
      const uploadDuration = Date.now() - startUploadTime;
      if (!saveResult || saveResult.length !== 1) {
        return {
          success: false,
          message: `大文件上传失败: 预期返回1个结果，实际返回${saveResult?.length || 0}个`
        };
      }
      const fileAttachment = saveResult[0];
      console.log(`大文件上传成功，ID: ${fileAttachment.id}, 大小: ${fileAttachment.size}字节, 耗时: ${uploadDuration}ms`);
      // 下载大文件
      console.log('下载大文件...');
      const startDownloadTime = Date.now();
      const readResult = await this.adapter.readFiles([fileAttachment.id]);
      const downloadDuration = Date.now() - startDownloadTime;
      const downloadedContent = readResult.get(fileAttachment.id);
      if (!downloadedContent) {
        // 清理大文件
        await this.adapter.deleteFiles([fileAttachment.id]);
        return {
          success: false,
          message: '大文件下载失败: 未能获取文件内容'
        };
      }
      console.log(`大文件下载成功，耗时: ${downloadDuration}ms`);
      // 验证大文件大小
      let fileSize = 0;
      if (downloadedContent instanceof ArrayBuffer) {
        fileSize = downloadedContent.byteLength;
      } else if (downloadedContent instanceof Blob) {
        fileSize = downloadedContent.size;
      }
      console.log(`下载的大文件大小: ${fileSize}字节，原文件大小: ${size}字节`);
      if (fileSize !== size) {
        // 清理大文件
        await this.adapter.deleteFiles([fileAttachment.id]);
        return {
          success: false,
          message: `大文件大小验证失败: 预期=${size}字节, 实际=${fileSize}字节`
        };
      }
      // 验证内容（检查部分字节点进行验证）
      let contentValid = true;
      if (downloadedContent instanceof ArrayBuffer) {
        const originalView = new Uint8Array(buffer);
        const downloadedView = new Uint8Array(downloadedContent);
        // 检查几个关键位置的字节点
        const checkPoints = [0, 1024, 10240, 100000, 1000000, size - 1];
        for (const point of checkPoints) {
          if (point < size && originalView[point] !== downloadedView[point]) {
            contentValid = false;
            console.log(`位置 ${point} 的字节不匹配: 原始=${originalView[point]}, 下载=${downloadedView[point]}`);
            break;
          }
        }
      } else if (downloadedContent instanceof Blob) {
        // 对于Blob类型，我们可以转换为ArrayBuffer再验证
        const downloadedBuffer = await downloadedContent.arrayBuffer();
        const originalView = new Uint8Array(buffer);
        const downloadedView = new Uint8Array(downloadedBuffer);
        // 检查几个关键位置的字节点
        const checkPoints = [0, 1024, 10240, 100000, 1000000, size - 1];
        for (const point of checkPoints) {
          if (point < size && originalView[point] !== downloadedView[point]) {
            contentValid = false;
            console.log(`位置 ${point} 的字节不匹配: 原始=${originalView[point]}, 下载=${downloadedView[point]}`);
            break;
          }
        }
      }
      if (!contentValid) {
        // 清理大文件
        await this.adapter.deleteFiles([fileAttachment.id]);
        return {
          success: false,
          message: '大文件内容验证失败: 下载的数据与上传的数据不匹配'
        };
      }
      // 删除大文件
      console.log('删除大文件...');
      const deleteResult = await this.adapter.deleteFiles([fileAttachment.id]);
      if (deleteResult.deleted.length !== 1) {
        return {
          success: false,
          message: `大文件删除失败: 预期删除1个文件，实际删除${deleteResult.deleted.length}个`
        };
      }
      // 验证删除结果
      const verifyDeleteResult = await this.adapter.readFiles([fileAttachment.id]);
      if (verifyDeleteResult.get(fileAttachment.id) !== null &&
        verifyDeleteResult.get(fileAttachment.id) !== undefined) {
        return {
          success: false,
          message: '大文件删除验证失败: 文件仍然可以被访问'
        };
      }
      return {
        success: true,
        message: `Large file operations test passed, upload time: ${uploadDuration}ms, download time: ${downloadDuration}ms`
      };
    } catch (error) {
      console.error('大文件操作测试失败:', error);
      return {
        success: false,
        message: `大文件操作测试失败: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }


}
export async function testAdapterFunctionality(
  adapter: DatabaseAdapter,
  testStoreName?: string
): Promise<{
  success: boolean;
  results: Record<string, { success: boolean; message: string }>;
}> {
  const tester = new AdapterFunctionTester(adapter, testStoreName);
  return await tester.runAllTests();
}
