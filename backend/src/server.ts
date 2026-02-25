import express from "express"
import {
    S3Client,
    CreateMultipartUploadCommand,
    UploadPartCommand,
    CompleteMultipartUploadCommand,
    AbortMultipartUploadCommand,
    ListPartsCommand
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import dotenv from 'dotenv'
import cors from 'cors'

const app = express()

dotenv.config()


app.use(cors({
    origin: "*",
    credentials: true
}));

app.use(express.json());

const s3 = new S3Client({
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY!,
        secretAccessKey: process.env.AWS_SECRET_KEY!
    },
    region: process.env.AWS_REGION

});




const Bucket = process.env.AWS_BUCKET;


app.post("/uploads/start", async (req, res) => {
    const { fileName, contentType } = req.body;

    const command = new CreateMultipartUploadCommand({
        Bucket,
        Key: `videos/${Date.now()}-${fileName}`,
        ContentType: contentType
    });

    const response = await s3.send(command);

    res.json({
        uploadId: response.UploadId,
        key: response.Key
    });
});



app.post("/uploads/part-url", async (req, res) => {
    const { key, uploadId, partNumber } = req.body;

    const command = new UploadPartCommand({
        Bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber
    });

    const url = await getSignedUrl(s3, command, { expiresIn: 3600 });

    res.json({ url });
});


app.post("/uploads/complete", async (req, res) => {
    const { key, uploadId, parts } = req.body;

    const command = new CompleteMultipartUploadCommand({
        Bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts }
    });

    await s3.send(command);

    res.json({ success: true });
});


app.get("/uploads/parts", async (req, res) => {
    const key = req.query.key as string;
    const uploadId = req.query.uploadId as string;

    const command = new ListPartsCommand({
        Bucket,
        Key: key,
        UploadId: uploadId
    });

    const data = await s3.send(command);

    res.json({ parts: data.Parts || [] });
});


app.delete("/uploads/abort", async (req, res) => {
    const { key, uploadId } = req.body;

    const command = new AbortMultipartUploadCommand({
        Bucket,
        Key: key,
        UploadId: uploadId
    });

    await s3.send(command);

    res.json({ aborted: true });
});




app.get("/", (req, res) => res.status(200).send("SERVER IS RUNNING"))


app.listen(5000, () =>
    console.log("Server Running on PORT:", 5000)
);