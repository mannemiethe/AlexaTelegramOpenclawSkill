import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const s3 = new S3Client({});
const KEY = 'waiting_sound.mp3';

export const handler = async (event) => {
  console.log('UploadAudio event:', JSON.stringify(event));
  const { RequestType, ResourceProperties } = event;
  const { BucketName } = ResourceProperties;

  try {
    if (RequestType === 'Delete') {
      await s3.send(new DeleteObjectCommand({ Bucket: BucketName, Key: KEY }));
    } else {
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const body = readFileSync(join(__dirname, KEY));
      await s3.send(new PutObjectCommand({
        Bucket: BucketName,
        Key: KEY,
        Body: body,
        ContentType: 'audio/mpeg',
      }));
    }
    await cfnRespond(event, 'SUCCESS', {});
  } catch (err) {
    console.error(err);
    await cfnRespond(event, 'FAILED', {}, String(err));
  }
};

async function cfnRespond(event, status, data, reason = 'OK') {
  const body = JSON.stringify({
    Status: status,
    Reason: reason,
    PhysicalResourceId: event.PhysicalResourceId || 'waiting-sound-upload',
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: data,
  });
  await fetch(event.ResponseURL, {
    method: 'PUT',
    body,
    headers: { 'Content-Type': '' },
  });
}
