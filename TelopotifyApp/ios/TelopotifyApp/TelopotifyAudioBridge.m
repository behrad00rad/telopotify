#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(TelopotifyAudio, NSObject)

RCT_EXTERN_METHOD(play:(NSString *)url title:(NSString *)title artist:(NSString *)artist)
RCT_EXTERN_METHOD(playTelegram:(nonnull NSNumber *)fileId fileSize:(nonnull NSNumber *)fileSize mimeType:(NSString *)mimeType title:(NSString *)title artist:(NSString *)artist)
RCT_EXTERN_METHOD(setQueue:(NSArray *)tracks startId:(NSString *)startId)
RCT_EXTERN_METHOD(appendQueue:(NSArray *)tracks)
RCT_EXTERN_METHOD(next)
RCT_EXTERN_METHOD(previous)
RCT_EXTERN_METHOD(pause)
RCT_EXTERN_METHOD(resume)
RCT_EXTERN_METHOD(stop)
RCT_EXTERN_METHOD(seek:(double)seconds)
RCT_EXTERN_METHOD(setVolume:(double)value)
RCT_EXTERN_METHOD(setSpeed:(double)value)
RCT_EXTERN_METHOD(getSnapshot:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)

@end
