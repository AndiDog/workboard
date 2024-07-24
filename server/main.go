package main

import (
	"errors"
	"log"
	"net"
	"os"
	"os/signal"
	"sync"
	"syscall"

	"andidog.de/workboard/server/api"
	"andidog.de/workboard/server/proto"
	"github.com/joho/godotenv"
	"google.golang.org/grpc"
)

func main() {
	envFiles := []string{".env"}
	if _, err := os.Stat(".env-local"); err == nil || !errors.Is(err, os.ErrNotExist) {
		envFiles = append(envFiles, ".env-local")
	}
	err := godotenv.Load(envFiles...)
	if err != nil {
		log.Fatalf("Error loading env files (%v)", envFiles)
	}

	// gRPC setup
	grpcListenAddress := os.Getenv("GRPC_LISTEN_STRING")
	if grpcListenAddress == "" {
		log.Fatal("Missing GRPC_LISTEN_STRING environment variable")
	}
	grpcListener, err := net.Listen("tcp", grpcListenAddress)
	if err != nil {
		log.Fatalf("Failed to listen: %v", err)
	}
	var opts []grpc.ServerOption
	grpcServer := grpc.NewServer(opts...)
	workboardServer, err := api.NewWorkboardServer()
	if err != nil {
		log.Fatalf("Failed to start: %v", err)
	}
	proto.RegisterWorkboardServer(grpcServer, workboardServer)

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, os.Interrupt, syscall.SIGTERM)

	var wg sync.WaitGroup

	// Start gRPC server
	wg.Add(1)
	go func() {
		defer wg.Done()
		log.Printf("Starting gRPC server on %s", grpcListener.Addr())
		if err := grpcServer.Serve(grpcListener); err != nil {
			log.Fatalf("Failed to listen (gRPC): %s\n", err)
		}
		log.Printf("gRPC server successfully shut down")
	}()

	<-quit
	log.Print("Got shutdown signal")

	log.Print("Shutting down gRPC server")
	grpcServer.GracefulStop()

	wg.Wait()
	log.Println("Servers stopped, quitting")
}
